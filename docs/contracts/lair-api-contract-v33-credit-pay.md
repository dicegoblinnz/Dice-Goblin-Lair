# Lair API contract v33: paying with store credit (My Lair's bill and the till)

Round 33, 7 November 2026. Mo: "I want to add pay using store credit for clients as an extra option thanks." Asked where,
he picked both: **the counter till** (store credit next to card and cash) and **My Lair's bill** (a Pay with store credit
button beside Pay with cash).

**Changes only**, on top of every contract before it (the till's is v32-till, store credit's v30-credit). Times in ms
(UTC), amounts in cents. Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Store credit is Shopify's (a customer's store credit account): the Lair takes it off with `storeCreditAccountDebit` and
puts it back with `storeCreditAccountCredit`, as damage charges (round 10) and gifts (round 30) do. Nothing the browser
says about a balance or a total is trusted: Shopify refuses to take off more than there is, and the Lair works out the
bill and the sale itself. Online at Shopify's checkout and on Shopify POS, store credit already works as it did.

`src/credit-pay.js`, and the till's part in `src/till-sales.js`; tests `test/round33-credit-pay.test.js`.

## 1. Every payment is a row before Shopify is asked

`credit_payments`: one row for each time store credit is taken to pay for something, written before Shopify is asked,
so it never moves twice:

| status | means |
|---|---|
| `taking` | coming off their store credit now |
| `taken` | it came off (a till sale's, held while the rest is paid by card or cash) |
| `paid` | it paid for what it was taken for (My Lair's bill, or a till sale) |
| `checking` | Shopify didn't answer while it came off (it may or may not have) |
| `returning` | it came off, but it isn't paying for anything after all, so it's going back on now |
| `returned` | it came off and went back on: nothing moved in the end |
| `failed` | nothing came off (Shopify said no, there wasn't enough, or it never came off) |
| `check` | Shopify didn't answer while it went back on (or can't be read): staff look in Shopify admin |

**A lost answer never pays anything.** One that turns out to have come off (the 10-minute run finds it in their store
credit, from 2 minutes on) goes back on; one not there after 30 minutes didn't come off (`failed`). Shopify unreadable for
2 hours, or no answer while it goes back on: `check`, and staff get "Check a store credit payment: Mia T." with what to
look for and what to do by hand. A row left `taking` by a restart mid-call (30 minutes) counts as an answer lost; one left
`returning` goes to staff. When the run looks for a lost one, it skips every debit the Lair already knows (gifts, damage
charges, staff changes and these), and the gifts' and damage charges' own looks skip these.

One at a time: a member with a payment `taking`, `checking` or `returning` gets 409 `busy` (My Lair) or `tillBusy` (the
till) until it's settled.

Data: `credit_payments (id, customer_id, source, sale_id, key, day, amount, currency, status, stage, items, lines,
take_tx, back_tx, balance_after, message, created_at, updated_at, paid_at, order_status, order_tries, order_next_at,
order_draft, order_sent_at, order_id, order_name, order_error)`; `source` is `me` or `till`; `key` is My Lair's own (unique
for each member); `stage` is `take` or `back` for a `check`. `till_sales` gains `credit` (cents taken for it) and
`credit_id`.

## 2. My Lair's bill

| Route | Who | What |
|---|---|---|
| `POST /proxy/me/credit` | logged in | `{ expect, key }`: pay what's on My Lair's bill now from their store credit → `{ credit, balance, message }` |

The bill is what Pay with cash pays (contract v18-cash): today's bookings, seats and sign-ups with something to pay, what's
owed from before, and today's tab. First, any session pass saved on today's bookings is used, as checking in uses it
(nobody is checked in: staff still do that at the counter, where it shows as paid). Then:

- `expect` is the total they were shown (cents). When the bill comes to something else now (a pass took some off, or the
  tab changed), nothing's taken: 409 `changed`. When the pass covered it all: 409 `passCovered`.
- `key` (8 to 64 letters, numbers, dashes or underscores) is the page's own for this payment: the same key again gives
  back the first payment as it stands (`repeated: true`) and moves nothing. 400 `key` otherwise.
- It needs all of it to be covered: their balance less than the bill is 409 `short`, and nothing's taken (the counter can
  take part in store credit and the rest by card).
- Not on a monthly account (409 `monthly`: that's their monthly bill). Nothing to pay: 409 `nothing`. Today's tab, or a
  booking on the bill, being rung up at the till right now: 409 `atCounter`. Shopify not connected, or their balance
  unreadable: 503 `off`.
- Shopify says there isn't enough: 409 `shortNow`; says no otherwise: 409 `notTaken`. No answer: 200 with
  `credit.status` `checking` and the message `checking` (see section 1).
- Taken, and the bill still exactly what it was: it's paid. Each booking, seat and sign-up gets a payment for what it
  owed (order `credit:<id>`, the member as the payer, as cash's do), today's tab is paid, what's owed is settled, a TTRPG
  seat's GM gets their fee as for any payment (round 30), a waiting Pay with cash request ends, and a stamp follows from
  being paid on the day (round 22). Its Shopify order is made in the background (below). → `{ credit, balance, message:
  paid }`, `balance` their store credit after it (cents), when Shopify said.
- Taken, but something on the bill was paid another way meanwhile: it all goes back on (`returning`), nothing's paid,
  409 `paidElsewhere`.

A payment as the member sees it (`credit`): `{ id, status: 'paid' | 'checking' | 'failed' | 'returned', amount, items, at,
paidAt }`; `items` as Pay with cash lists them (`{ kind, id, ref?, title, amount, things? }`). GET /me gains `creditPay`:
their payment still being checked (`taking`, `checking` or `returning`), as that view, or null.

**Its Shopify order.** As cash's (contract v18-cash): a draft for the member with a custom line for each booking at what it
paid and the tab's things as their products at the tab's price (so stock comes off), tagged `lair-credit` and
`store-credit`, noted "Paid from store credit in My Lair (cp_…)." (no booking codes: the orders/paid webhook reads them
from a draft's note), with the payment's id in its `_lair_credit` attribute, made a paid order. Claimed, tried again after
10 minutes, 30, 1 hour, 3, 6, 12 and 24, looked for by its marker before another is made, and staff told ("Store credit
with no Shopify order: Mia T.") when it can't be. A total that doesn't match: "A store credit order that doesn't match".

## 3. The till

`POST /proxy/till/pay` takes store credit (contract v32-till section 6, changed):

`{ lines, person?, method: 'card' | 'cash' | 'credit', credit?: true, token?, till? }`

- `method: 'credit'`: store credit pays all of it. `credit: true` with `card` or `cash`: store credit pays first, as much
  as it covers, and the rest is paid by card or cash. Either needs a member on the sale (`person`): 422 `tillPerson`.
  Their balance is read first: unreadable, 503 `tillOff`; none, 409 `tillNone`.
- The draft is made as before (the price fixed), then the store credit is taken there and then, **with no PIN** (Mo, 6
  Nov 2026: no extra guard on store credit at the till; a scanned code is enough).
  - It covers the sale: the sale is paid at once → `{ sale }` with `status: 'paid'`, and its order is made and fulfilled
    as any paid sale's. Taken by the person on the till, or `customer` on the customer screen.
  - It covers part: the sale is open with `credit` (taken) and `due` (left to pay). `/till/paid`'s `expect` is now `due`
    (409 `expect(due)` otherwise); confirming it marks the store credit `paid` too.
  - `method: 'credit'` and their balance less than the total: 409 `tillShort`, the sale's let go.
  - Shopify says there isn't enough (their balance changed): 409 `tillChanged`; says no otherwise: 409 `tillNotTaken`;
    no answer: 503 `tillLost` (section 1). The sale is let go in each case.
  - Something in it was paid another way while the credit came off: 409 `paidElsewhere` (as before), the credit goes back.
- **Letting go** (Back, a new sale on the till, Shopify failing, the 12-hour run) puts any store credit taken for it back on
  their account (`returning`, then `returned`; no answer: staff check, section 1).

The sale (`sale`) gains `credit` (cents from store credit, 0 for none) and `due` (total less credit). The draft is tagged
`lair-till`, `till`, the method, and `credit` and `store-credit` when store credit is in it; its note says how: "Sold on the
Lair till, with store credit and by card on the EFTPOS, rung up by Hemi (ts_…)" or "Sold on the Lair till, with store
credit (ts_…)" (the price isn't known when the draft is made, so the amounts are the sale's `credit` and `due`, and the
member's store credit history in Shopify). The orders/paid webhook treats it as any till sale. `method` missing or not one of these: 400
`method`, now `Pay by card, with cash or with store credit.`

## 4. The words

Every message, word for word (`CREDIT_PAY_WORDS`, `src/credit-pay.js`):

| Key | Words |
|---|---|
| `login` | Log in to pay with your store credit. |
| `noAccount` | Open My Lair once first, then try again. |
| `key` | That didn't come through properly. Try again. |
| `expect` | expect is the amount you were shown, in cents. |
| `monthly` | You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter. |
| `nothing` | There's nothing to pay right now. |
| `passCovered` | Your session pass covered it, so there's nothing to pay. |
| `changed(total)` | Your bill's $15.00 now (a session pass took some off, or something changed). Check it, then pay again. |
| `atCounter` | It's being rung up at the counter right now, so pay there. |
| `off` | Store credit can't be used right now. Try again in a minute. |
| `short(balance, total)` | You have $8.50 of store credit, so it doesn't cover $15.00. Use it at the counter and pay the rest there. (No balance: You don't have any store credit right now.) |
| `shortNow` | You don't have that much store credit now. Check your balance, then try again. |
| `notTaken(why)` | Shopify didn't take the store credit off your account (why). Nothing moved. Try again in a minute. |
| `busy` | Your last store credit payment is still being checked. Try again in a few minutes, or pay at the counter. |
| `checking` | Shopify didn't answer, so your bill wasn't paid. If any store credit came off, Gobgob puts it back within 30 minutes. |
| `paidElsewhere` | Something on your bill was paid another way just now, so your store credit's going back on. Check your bill, then pay again. |
| `paid(total, balance)` | Paid! $15.00 came off your store credit, and $8.50 is left. (No balance said: Paid! $15.00 came off your store credit.) |
| `tillPerson` | Store credit needs a member on the sale: scan their code first. |
| `tillOff` | Shopify didn't answer about their store credit. Try again in a moment, or pay another way. |
| `tillNone` | They don't have any store credit right now. |
| `tillShort(balance, total)` | Their store credit is $4.50, so it doesn't cover $19.00. Use it for part, and pay the rest by card or cash. |
| `tillChanged` | Their store credit changed while it was paying, so this sale wasn't saved. Scan their code again. |
| `tillNotTaken(why)` | Shopify wouldn't take their store credit (why), so this sale wasn't saved. Pay another way. |
| `tillLost` | Shopify didn't answer about their store credit, so this sale wasn't saved. Any that came off goes back on by itself within 30 minutes. |
| `tillBusy` | Their last store credit payment is still being checked. Pay another way, or try again in a few minutes. |

## 5. Next (not in this round)

Paying a monthly account's bill with store credit; a staff tap to settle a `check` (staff fix it by hand from the email,
with the member page's Add or take off store credit); store credit for bookings on days to come.

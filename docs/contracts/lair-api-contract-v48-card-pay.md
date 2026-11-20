# Lair API contract v48: paying My Lair's bill by card on the phone

Round 48, 20 November 2026. Mo: "give people the ability to pay on their phone and account without having to go to the
till", "the staff can see who needs to be paying or is paid on their side", "encourage one big transaction rather than
many small ones", and "start building the pay my tab and we can plug in whatever we need to plug in when we get it".

**Changes only**, on top of every contract before it (cash's is v18-cash, store credit's v33-credit-pay). Times in ms
(UTC), amounts in cents. Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

`src/card-pay.js` (the payments), `src/card-providers.js` (who takes the card), `src/paid-order.js` (its Shopify order);
tests `test/round48-card-pay.test.js`. **Nothing shows to customers yet:** with no provider set, `cardPay.on` is false and
the route answers 503 `off`. The theme's button and the staff page's list are the next round.

## 1. The provider is a setting

`CARD_PROVIDER` (D1 `config`) names an adapter in `src/card-providers.js`; unset, or a name with no adapter, and card pay
is off. An adapter is `{ name, start, look, refund }`:

- `start({ id, amount, currency, title, back, expiresAt })` → `{ ref, url }`: a hosted card page for exactly `amount`
  that stops taking payment at `expiresAt`. `url` must be https or the page is never handed out.
- `look(ref)` → `{ status: 'open' | 'paid' | 'failed', amount }`, asked server to server.
- `refund(ref, amount, key)` → `{ id }`, safe to ask twice with the same key.
- `cancel(ref)` (optional): close a replaced page so it can't be paid.

`amount` is whole cents both ways: an adapter turns a provider's surcharge or dollars back into the bill's number, or
the payment goes to staff. A currency that comes back different goes to staff too.

The Lair never sees a card number, and nothing the browser says pays anything: only `look`'s answer does, and only when
the amount the provider took is the bill's. No adapter is written yet. Verifone's (eftpos NZ) waits on their answers
(hosted checkout through the API in NZ, a sandbox, status look-ups, refunds); Shopify's own checkout could be one too.
The provider's keys are Worker secrets, never in the repository.

## 2. One payment for the whole bill

The bill is what Pay with cash and Pay with store credit pay (`cashBill`): today's bookings, seats and sign-ups with
something to pay, what's owed from before, and today's tab. It is always paid whole. There is no paying one thing at a
time, which is what keeps it to one card payment a visit.

| Route | Who | What |
|---|---|---|
| `POST /proxy/me/card` | logged in | `{ expect, key, back? }`: open a card page for the bill → `{ card, url, message }` |
| `POST /proxy/me/card/:id` | logged in, their own | ask the provider how it stands now → `{ card, message }` |

`POST /me/card`:
- `expect` and `key` as store credit's (v33, section 2): 409 `changed` when the bill comes to something else, the same
  key again gives back that payment (`repeated: true`). `back` is a path on the website for the card page to return to;
  anything that isn't a plain path becomes `/`.
- Saved session passes on today's bookings are used first, as store credit's does. All covered: 409 `passCovered`.
- 409 `monthly` (their monthly bill instead), 409 `nothing`, 409 `atCounter` (being rung up at the till), 409 `busy` (a
  payment of theirs is still starting or being refunded), 503 `off` (no provider), 503 `notStarted` (no page came back).
- A page of theirs still open for the same bill, with more than 2 minutes left, is handed back (`repeated: true`). For a
  bill that's changed, the old page closes (`expired`) and a fresh one is made. A page takes payment for 30 minutes.
- **Opening a page pays nothing.**

When the provider says it's paid (asked by `POST /me/card/:id` when they come back, and by the 10-minute run for anyone
who closed the tab):
- for exactly the bill, and the bill is still the same things at the same amounts and isn't at the till: **paid**. Each
  booking, seat and sign-up gets a payment (order `card:<id>`, the member as the payer), today's tab is paid, what's owed
  is settled, the GM's fee and the day's stamp follow as for any payment, and a waiting Pay with cash request ends. One
  shared step with store credit's (`settleMyBill`).
- but the bill changed or was paid another way meanwhile: nothing is paid and it all goes back to the card
  (`refunding` → `refunded`). A refund the provider doesn't confirm is `check`, and staff get "Refund a card payment by
  hand: Mia T." with the provider's reference.
- for some other amount: `check`, staff hear, nothing is paid.

**A closed page is still watched.** A page that closed unpaid (ran out, was replaced, or had a try fail) is asked about
on every 10-minute run, and whenever its member asks, until 2 hours after its time ran out. Paid late, it still pays the
bill when nothing changed, and is refunded when something did, so a charged card is never left unanswered. From a
member's page the provider is asked about one payment at most every 3 seconds. While no provider is set nothing is
asked, so switch one off only when no pages are open.

`card`: `{ id, status: 'open' | 'paid' | 'failed' | 'expired' | 'refunding' | 'refunded' | 'check', amount, items, at,
paidAt, expiresAt, url }` (`url` only while its page takes payment; `items` as Pay with cash lists them).

`GET /me` gains `cardPay: { on, open, nudgeUnder, hint }`: `on` when a provider is set and they pay each visit; `open`
their payment still to finish or being sorted (`open`, `refunding`, or `check` for 3 days), or null; the page shows `hint` under the
button while the bill is under `nudgeUnder` (2000).

**Its Shopify order**, as cash's and store credit's: a paid order made in the background for the member, a custom line
for each booking and the tab's things as their products (so stock comes off), tagged `lair-card` and `card`, noted "Paid
by card in My Lair (kp_…).", marker `_lair_card`. Same retries and staff alerts, from `src/paid-order.js`, which is
written for any payments table (cash and store credit can move onto it later).

## 3. Staff

`GET /floor` gains, for staff who take cash (Check-in or Money): `paidOnPhone: [{ id, how: 'card' | 'credit',
customerId, name, code, amount, items, paidAt }]`, everyone who paid their own bill on their phone today, newest first.
A bill that isn't paid stays owed on the member's account and at the till exactly as before, so nobody is waved through
on their word alone.

## 4. The words

`CARD_PAY_WORDS` in `src/card-pay.js`, word for word:
- `login` "Log in to pay by card." · `noAccount`, `key`, `expect`, `monthly`, `nothing`, `passCovered`, `changed`,
  `atCounter`: as store credit's.
- `off` "Paying by card on your phone isn't switched on right now. Pay at the counter."
- `notStarted` "The card page didn't open, so nothing was paid. Try again in a minute, or pay at the counter."
- `busy` "Your last card payment is still being sorted out. Try again in a few minutes, or pay at the counter."
- `notFound` "That card payment could not be found."
- `opening` "Your card page is still opening. Give it a moment."
- `waiting` "Your card page is ready. Finish paying there."
- `notYet` "That payment hasn't come through yet. Finish it on the card page, or pay at the counter."
- `failed` "That card payment didn't go through, so nothing was paid. Try again, or pay at the counter."
- `expired` "That card page timed out, so nothing was paid. Tap Pay by card again."
- `paid` "Paid! $27.00 by card. Gobgob's ticked it off."
- `refunding` "Something on your bill was paid another way just now, so your card payment is going straight back to your
  card. Check your bill."
- `refunded` "Your bill had changed, so that card payment went back to your card. Check your bill, then pay again if
  there's anything left."
- `check` "Your card was charged, but your bill had changed, and the refund needs a hand from staff. Show this at the
  counter and we will sort it."
- `hint` "Still playing? Pay once at the end of the night and it all goes through in one go."

## 5. Next (not in this round)

- The provider's adapter, once Verifone's answers are in, and its webhook if they have one (the 10-minute run and the
  member coming back already cover it without).
- The theme: Pay by card on My Lair's bill card and the table QR page, and the staff page's "Paid on their phone" list.
- Cash and store credit moved onto `src/paid-order.js`.
- A staff "sorted" button for a payment in `check`.

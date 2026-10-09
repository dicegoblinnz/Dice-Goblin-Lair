# Lair app API: round 10, library memberships [memberships] (9 Oct 2026)

**Changes only**, on top of v9 and everything before it; where they disagree, this file wins. Money in cents, times in
ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.
Backend branch `memberships` (live since 9 Oct); the theme work (section 6) is on the theme's `dice-goblin-2-theme`
branch (10 Oct), so it shows on the unpublished Dice Goblin 2.0 theme.

Mo (9 Oct): "I want to build a new Shopify app to help replace the subscription app that I have called simplee", for
the board game library (Grab, Stash and Hoard, unlimited swaps), and to charge members' saved cards for damaged, missing
or lost games. Agreed defaults (Mo can change any of them): a damage charge gets 7 days' notice before it goes on the
next bill; cancelling runs to the end of the month paid for, and a damage charge still owed is then billed on its own,
without another month's fee; a plan change takes effect from the next bill; a failed renewal is tried again 3 days and
7 days after the first failure, then the membership ends; borrowing is paused while a payment is outstanding.

Mo (9 Oct, later): "make sure there is a way for us to charge a client not on the next billing cycle but immediately
for any of the damages ... after emails have been sent out ... either by taking their credit or charging their card
immediately", with emails for failures and damage notices. So once a damage charge's notice has been emailed, staff
can take it straight away from the member's store credit or saved card (section 2, "Taking a damage charge now"). The
welcome email (and the product page's terms, section 6) now say a charge usually goes on the next bill after 7 days but
can be taken straight away.

## 1. How it fits together

- **Lair Memberships** is a second Shopify app (Dev Dashboard, client credentials), separate from the Lair's own, so
  card access never rides on the Lair's token. It owns the membership selling plans and the subscription contracts
  people make at checkout. The Lair logs in as it with `MEMBERSHIPS_CLIENT_ID` and `MEMBERSHIPS_CLIENT_SECRET`.
- **Joining** is a normal Shopify checkout of the membership product with a plan picked (the theme's selling plan
  selector). The checkout pays the first month. Shopify's `subscription_contracts/create` webhook makes the membership
  in the Lair; the member gets "Welcome to the Dice Goblin library!" and `STAFF_EMAIL` hears.
- **Shopify keeps the card; the Lair decides when to charge.** Each month the Lair bills one Shopify billing cycle
  (`subscriptionBillingAttemptCreate`, with the cycle's index and an idempotency key `lair-membership-<contract>-c<cycle>-a<try>`).
  Shopify's billing attempt webhooks say how it went. Every payment is a Shopify order.
- **Nothing charges a card until `MEMBERSHIPS_BILLING` is `on`.** Until then the Lair keeps its records up to date
  and the status table counts who's `waiting`.
- **Damage charges ride on the member's next bill:** that cycle only gets a line for each charge on the damage charge
  product (setup makes it: "Library damage charge", on no sales channel), so it's one payment and one order.
- **Or staff take one now:** from store credit (the Lair's own app, `storeCreditAccountDebit`), or on the saved card.
  A subscription app can only charge a card by billing a contract, so the charge gets a one-off contract of its own
  (`subscriptionContractAtomicCreate`: the member's payment method, one line on the damage charge product at the
  charge's price, its one bill due within the hour), billed once (`lair-damage-<payment>`), then cancelled. It has no
  library plan on it, so it never becomes a membership.
- Code: `src/memberships.js` (all of it), wired into `src/lair.js` (migration, routes, the library plan), `src/index.js`
  (`/webhooks/memberships`) and `src/config.js`. Tests: `test/round10-memberships.test.js`.

## 2. Rules

**Plans.** Grab 1 game at a time ($30 a month), Stash 3 ($60), Hoard 5 ($75); unlimited swaps. Games at a time counts
holds and games at home together, as before.

**Where a library plan comes from** (`library.plan` on GET /me, holds, scans, the staff page):
- the member's current membership: `active`, `past_due` (a payment is outstanding: `blocked: true`, no new holds or
  borrowing, 402) or `cancelling` until its end;
- else, for someone who has **never had a Lair membership**, their Simplee tags (as before), until
  `MEMBERSHIPS_SIMPLEE_TAGS` is `off`;
- else none. A paused or ended membership gives no plan, and old Simplee tags never bring one back.

**Renewals.**
- Billed at Shopify's billing cycle date (`billingAttemptExpectedDate`, the end of each monthly cycle). The first
  renewal is the first unbilled cycle at least 25 days after joining (staff hear if Shopify's is more than 35 days on).
- Once per cycle: one charge in flight per membership, claimed (its row written) before Shopify is asked, from a
  freshly read row that's due right now; one maintenance run at a time. Before every send the cycle is read (billed or
  skipped already: not billed again, and staff hear) and given exactly that charge's damage charges, or none.
- **Never late, never in a burst.** A cycle more than 2 days past its date isn't billed: the membership moves on to the
  next cycle that isn't, and staff get "Library bills that were too late to take" (billing was off, the Lair was down,
  or the contract was paused). The same for a failed payment whose next try would be more than 2 days late: that month
  is dropped and borrowing is back on. A bill that hasn't reached Shopify 2 days after it was claimed is dropped.
- A send that never came back is looked up by its key before anything else; an attempt Shopify has is followed, never
  sent again. Webhooks are matched by key (Shopify's payload can have no attempt id).

**Failed payments** (only a failure on the member's card counts as a try):
- First failure: Shopify's own card update email (`customerPaymentMethodSendUpdateEmail`), "Your library payment didn't
  go through" (with when it's tried again), borrowing paused. Tries again 3 days, then 7 days, after the first failure;
  a new card (`customer_payment_methods/create` or `/update`, card changed on the contract) tries again on the next run.
  After the third failure the membership is `ending`: "Your library membership has ended" (games at home, damage
  charges to pay at the counter), staff hear, and the next run fails the contract in Shopify.
- **The bank flags fraud:** never tried again on its own; a new card gets one more try; no new card in 7 days and it ends.
- **A bank check (3D Secure):** Shopify emails the member. It's never tried again while it waits (the check could still go
  through). After 3 days borrowing pauses and the member hears ("Your bank wants you to confirm your library payment");
  after 7 days it ends. A late success is still taken.
- **Not the card** (the store, the payment provider, Shopify or stock: `NOT_THE_CARD` in the code), and **Shopify
  refusing a bill** (a userError: under review, paused, a cycle problem): nothing counts against the member, who isn't
  told; staff hear; billing waits a day. After 3 for the same bill, billing stops for 30 days (staff press Retry once
  it's sorted). A card the gateway can't take, or a wrong address, is the member's to fix and counts as a try.
- A payment that comes in late is taken. If that means a month was paid twice, or paid after the membership ended,
  staff hear (refund one in Shopify).

**Plan changes** (`POST /me/membership/change`): from the next bill. The contract's price changes now; the games at a
time change when that bill is paid, so moving up and back down before it can't skip paying. Not while a payment is in
flight or outstanding, or for a membership that's ending. Nothing is billed for the member while the change is with
Shopify.

**Cancelling** (`POST /me/membership/cancel`, or staff): no more bills.
- Paid up: it runs to the end of the month paid for (the next bill date), and can be kept until then.
- A payment outstanding: it ends now (that month was never paid).
- A payment in flight: a claim Shopify never got is dropped (it ends at the end of the paid month, usually now); one
  Shopify has decides: paid, it runs to the end of the month that paid for; not, it ends now. The email says so.
- Any damage charge still owed is billed on its own when the month runs out, without another month's fee. Then the
  contract is cancelled in Shopify and "Your library membership has ended" goes out (staff hear about games at home).

**Paused in Shopify** (by staff in Shopify admin): no billing and no plan; `paused_from` keeps what it was, so it goes
back to that (a cancelled membership stays cancelled). Missed months aren't billed. **Ended in Shopify** outside the
Lair (an uninstall, or an admin): it ends in the Lair too, staff hear, the member isn't emailed. Brought back in Shopify
after the Lair ended it: staff hear; the Lair doesn't bill it.

**Damage charges** (staff with `library` or `money`):
- Missing parts, damaged, or lost (not returned), $1 to $500 (no more than the game's RRP), for a member, from a loan or
  a title typed in.
- The member gets an itemised notice and has **7 days** to bring the bits back or dispute it in My Lair (the charge
  waits while it's sorted). Then it's due: on the next bill (that cycle only), billed on its own after cancelling, or,
  with no membership to bill, collected at the counter (staff hear).
- A new amount is a new notice, with 7 days again. Staff can waive it (the member hears), hold it (it waits, like a
  dispute), put it back (a waived one was told it was cancelled, so it gets a new notice and 7 days again), or mark it
  paid at the counter. A charge on a bill being paid, or being taken now, can't
  change (refund it in Shopify once it's gone through).
- On a bill that fails, a charge waits for the next try; when there's no next try it goes to staff (`unpaid`).

**Taking a damage charge now** (staff with `money`; Mo, 9 Oct):
- Only once its notice has been **emailed** (`emailedAt`: set when the email service has taken it, not before; a new
  amount, or putting a waived one back, needs its new notice first), and only one in its notice, due, or to collect at
  the counter: not one on a bill being paid, on hold or disputed, paid or waived.
- `use`: `credit` (their store credit), `card` (their saved card: their current membership's, else their latest
  membership's, even a cancelled or ended one) or `auto` (the default: store credit when the balance covers it, else
  the card, else store credit when Shopify won't say the balance). Never split between the two.
- Store credit comes off there and then. If Shopify says it's short, nothing came off (with `auto`, the card is used
  instead). Card charges need `MEMBERSHIPS_BILLING` on; store credit doesn't. A card the member's bank flagged as fraud
  (on a renewal or a charge taken now) isn't charged again until it's updated or replaced, even once the membership has
  ended.
- A card payment is with Shopify when the request answers (`pending`); the billing attempt webhooks finish it.
- **Logged with `chargeNow: true`:** the notice says it's being taken now ("Taken from your store credit today",
  "Charged to Visa ending 4242 today"), then it is, once the email service has taken the notice. With no way to (no
  email, no card, not enough store credit), the usual notice goes and `chargeNow` says why; if staff change the charge
  while its notice is going out, it isn't taken on that notice.
- **Never twice.** The payment is claimed (its row, the charge `charging`) before Shopify is asked; one in flight per
  charge. Store credit whose answer was lost is looked for in the account's debits (Shopify can't take a key for it):
  found, it's paid; not there 10 minutes on, it didn't come off. Only a debit made while this one was with Shopify
  counts, and one that could belong to another take-off of the same amount from the same account (a damage charge or
  the member page's store credit tool) is never taken for it: while that one waits on its answer this one waits, and if
  the two can't be told apart, staff decide. If the Lair can't read the account (`read_store_credit_accounts`)
  or can't tell for an hour, staff are asked to look in Shopify admin and settle it (not before the Lair's own look,
  10 minutes on). This follow-up runs even without Lair Memberships. A one-off contract whose answer was lost is found
  by its marker (`_lair_payment`) before another is made, and a bill by its key.
- **Paid:** the charge is `paid` (`paidVia` `credit` or `card`), the member gets a receipt ("Paid: the $40 charge for
  Catan", with the store credit left), and the one-off contract is cancelled on the next run.
- **Not taken:** the charge goes back to where it was (its notice, the next bill, or the counter) and staff hear. The
  member hears ("We couldn't take the charge for Catan", and where it goes instead) when it was their card (declined,
  expired, the bank check never done) or when their notice said it would be taken now; a problem on the store's side
  or Shopify refusing is staff's to sort.
- **A bank check:** the member hears ("Your bank wants you to confirm a $40 payment"); it's never tried again while it
  waits; not done in 7 days, it goes back (and they hear). A late success is still taken; if the charge was paid
  another way meanwhile, staff hear to refund one. The same the other way round: a library bill paid late with a
  damage charge on it that was since taken now (or paid at the counter) tells staff it was paid twice.
- A card payment that can't reach Shopify for 2 days is dropped (nothing charged); billing switched off drops one
  Shopify never got. Staff hear either way, and so does the member when their notice said it was being taken now. A
  cancelled membership waits for a charge being taken before it ends.

## 3. Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /proxy/me` | logged in | adds `membership`: the membership view (section 4) of their current one, else a paused one, else one that ended in the last 30 days, else `null`; with `plans` (`[{ key, name, games, price }]`). `library.plan` is `{ name, games }`, plus `blocked: true` while a payment is outstanding |
| `POST /proxy/me/membership/change` | logged in | `{ tier: 'grab' \| 'stash' \| 'hoard' }` → `{ membership }` ("Your library plan changes to Hoard") |
| `POST /proxy/me/membership/cancel` | logged in | `{}` → `{ membership }` ("Your library membership is cancelled") |
| `POST /proxy/me/membership/resume` | logged in | keep a cancelled membership that hasn't run out → `{ membership }` |
| `POST /proxy/me/membership/card` | logged in | Shopify emails them a secure link to update their card, at most once an hour → `{ sent: true, message }` |
| `POST /proxy/me/damage/:id/dispute` | the member | `{ note }` (up to 500) → `{ charge }`; it waits off any bill, staff hear |
| `POST /proxy/library/holds`, `/proxy/library/scan` | members | as before; a blocked plan is a 402 (`blocked` or `blockedBank`) |
| `GET /proxy/memberships?status=current\|past_due\|ended\|all&customerId=` | staff (`library`, `members` or `money`) | `{ memberships: [staff view], billing: 'on' \| 'off', counts: { active, past_due, cancelling } }`, newest first, up to 300. `current`: active, past_due, cancelling, ending and paused |
| `POST /proxy/memberships/:id/cancel` | staff (`money`) | `{ when: 'end' \| 'now' }` → `{ membership }` (the member gets the cancelled email) |
| `POST /proxy/memberships/:id/retry` | staff (`money`) | try a failed payment again on the next run (within 10 minutes), or lift a hold after Shopify refused a bill → `{ membership }` |
| `GET /proxy/library/damage?status=open\|all&customerId=` | staff (`library` or `money`) | `{ charges: [damage view + customerId, name, code, membershipId, by, note] }`, newest first, up to 200; `open`: notice, due, billing, charging, disputed, unpaid |
| `POST /proxy/library/damage` | staff (`library` or `money`; `chargeNow` needs `money`) | `{ customerId, loanId?, title?, reason: 'missing' \| 'damaged' \| 'lost', details? (300), amount (cents), chargeNow?: true, use?: 'auto' \| 'credit' \| 'card', key? }` → `{ charge: damage view + emailed, billable }` (`billable`: it can go on a bill), and with `chargeNow`, `chargeNow: { ok, message?, error?, payment: payment view \| null }`. `key` (up to 64): the page's own key for this one; sending it again (a double tap) answers the first again with `repeated: true`, never logging or taking it twice. The staff page should always send one |
| `POST /proxy/library/damage/:id/update` | staff (`money`) | `{ action: 'waive' \| 'hold' \| 'reinstate' \| 'counter' \| 'amount', amount?, note? }` → `{ charge }` |
| `POST /proxy/library/damage/:id/charge` | staff (`money`) | take it now: `{ use?: 'auto' \| 'credit' \| 'card' }` → `{ charge, payment: payment view, message }` (`message`: what happened, for staff). Store credit: `paid` there and then; card: `pending` until Shopify says (a 409 when Shopify refused there and then, with nothing charged) |
| `POST /proxy/library/damage/:id/settle` | staff (`money`) | store credit Shopify couldn't confirm (payment `checking`; staff were emailed): `{ taken: true \| false }` → `{ charge, payment }` |
| `GET /proxy/members/:customerId` | staff | `member.membership`: their current membership's staff view, else their latest, or `null`; `member.library.plan` as on GET /me |
| `POST /webhooks/memberships` | Lair Memberships (HMAC with its own client secret, shop checked) | contracts, billing attempts and payment methods; a repeat (same webhook id) does nothing |
| `GET /setup?key=…&memberships=plans` | you | also sets up memberships (section 7) and answers `membershipsSetup` |

Maintenance (every 10 minutes) adds `memberships` to its answer and the `connection` row: `{ configured, billing,
webhooks, checked, paidNow (damage charge payments followed up), fees, renewals, caughtUp, unbillable, charged, waiting,
gaveUp, ended }`.

## 4. Shapes

**Membership view** (GET /me's `membership`, and the start of the staff view):

```
{ id, status, tier: { key, name, games, price }, nextTier (the plan the next bill charges, when it differs) | null,
  price, nextBillAt | null, nextAmount (active: the month plus damage charges due) | null, retryAt (past_due) | null,
  cancelAt (cancelling) | null, endedAt, endReason ('payment' | 'cancelled' | 'shopify:cancelled' …) | null,
  card: { kind: 'card' | 'shop-pay' | 'paypal', brand, last4, expMonth, expYear } | null,
  live (it counts for borrowing now), bankCheck (a payment waits on their bank),
  canChange, canCancel, canResume, canUpdateCard, since,
  charges: [{ id, kind: 'renewal' | 'fees', cycle, attempt, amount, status, at, completedAt, error }] (the last 6),
  damage: [damage view] (open ones, and ones settled in the last 60 days),
  plans (GET /me only) }
```

- `status`: `active`, `past_due` (a payment failed or waits on a bank check; borrowing paused), `cancelling` (runs to
  `cancelAt`; `null` while a payment in flight decides), `ending` (couldn't be paid; ends in Shopify on the next run),
  `paused` (in Shopify) or `ended`.
- A charge's `status`: `claimed`, `pending`, `challenged` (a bank check), `paid` or `failed`; `error` is the failure's
  code. Charges Shopify never got (`void`) aren't listed.

**Staff view** adds `customerId, name, email, code, atHome` (games at home), `source` (`checkout`), `contract` (the
contract's gid) and `holdUntil` (billing on hold after a refusal or a failure on the store's side, else `null`).

**Damage view:** `{ id, title, reason, reasonWords ('Missing parts' | 'Damaged' | 'Lost or not returned'), details, amount,
status, dueAt, createdAt, resolvedAt, disputeNote, emailedAt, paidVia, canChargeNow, payment }`. `status`: `notice` (its
7 days), `due`, `billing` (on a bill being paid), `charging` (being taken now), `paid`, `waived`, `disputed` (waits:
the member disputed it, or staff hold it) or `unpaid` (to collect at the counter). `emailedAt`: when its notice was
emailed (`null`: it wasn't, so it can't be taken now). `paidVia` (when paid): `bill`, `card`, `credit` or `counter`.
`canChargeNow`: staff can take it now. `payment`: the latest try at taking it now, or `null`.

**Payment view** (a damage charge taken now): `{ id, method: 'credit' | 'card', status, amount, at, completedAt,
card ('Visa ending 4242', for card) | null, balanceAfter (store credit left, for credit) | null, error (when failed) | null }`.
`status`: `claimed` (not with Shopify yet, or its answer was lost: the Lair keeps trying), `checking` (store credit
whose answer was lost: being looked for; staff can settle it), `pending`, `challenged` (a bank check), `paid`, `failed`
or `void` (never reached Shopify).

## 5. Messages

`MEMBERSHIP_MESSAGES` in `src/memberships.js` (the theme's demo can import the same words):

| Key | Status | Words |
| --- | --- | --- |
| `login` | 401 | Log in to manage your library membership. |
| `none` | 404 | You're not in the library yet. Join on the library page. |
| `noneStaff` | 404 | No library membership with that ID. |
| `tier` | 422 | Pick Grab, Stash or Hoard. |
| `same` | 409 | You're already on Hoard. |
| `pastDue` | 409 | Sort out your last payment first, then you can change plans. |
| `ending` | 409 | Your membership is ending, so the plan can't change. Keep your membership first, then pick a new plan. |
| `editsWaiting` | 409 | You can change plans once your payment has gone through. |
| `changing` | 409 | Your plan is changing right now. Try again in a minute. |
| `plansNotReady` | 503 | Plan changes aren't open yet. Ask us at the counter and we'll sort it. |
| `shopifyDown` | 503 | Shopify didn't answer just now. Try again in a minute. |
| `notActive` | 409 | That membership isn't active, so there's nothing to cancel. |
| `notCancelling` | 409 | Your membership isn't set to end, so there's nothing to undo. |
| `tooLate` | 409 | Your membership has already ended. Join again on the library page. |
| `noCard` | 409 | There's no card on your membership. Ask us at the counter. |
| `cardSoon` | 429 | Shopify sent you a link in the last hour. Check your inbox, and your spam folder too. |
| `blocked` | 402 | Your last library payment didn't go through, so borrowing is paused. Update your card in My Lair and Gobgob will try again. |
| `blockedBank` | 402 | Your bank wants you to confirm your last library payment, so borrowing is paused. Look for the email from Shopify, and check your spam folder too. |
| `feeAmount` | 422 | A charge is $1 to $500 (no more than the game's RRP). |
| `feeReason` | 422 | Pick what happened: missing parts, damaged, or lost. |
| `feeTitle` | 422 | Say which game it is. |
| `feeMember` | 404 | No member with that customer ID. |
| `feeLoan` | 404 | That loan isn't this member's. |
| `feeNone` | 404 | That charge could not be found. |
| `feeNotYours` | 403 | That charge isn't yours. |
| `feeLocked` | 409 | That charge is being paid right now. Once it's gone through, refund it in Shopify if you need to. |
| `feeDispute` | 409 | That charge can't be disputed now. Have a chat with us at the counter. |
| `feeAction` | 422 | Pick waive, hold, reinstate, counter (paid at the counter) or a new amount. |
| `feeChange` | 409 | That charge can't change now. |
| `staffWhen` | 422 | Pick when it ends: 'end' (at the end of the month they've paid for) or 'now'. |
| `retryNotDue` | 409 | That membership's payments are fine, so there's nothing to retry. |
| `retryBank` | 409 | That payment is waiting on the member's bank check, so it can't be tried again yet. |
| `feeUse` | 422 | Pick 'credit' (their store credit), 'card' (their saved card) or 'auto' (store credit if it covers it, else the card). |
| `feeNotEmailed` | 409 | The notice hasn't been emailed yet, so it can't be charged now. Check the member has an email address. |
| `feeOnHold` | 409 | That charge is on hold. Put it back on first. |
| `feePaid` | 409 | That charge is paid already. |
| `feeWaived` | 409 | That charge was waived. Put it back on first. |
| `cardsOff` | 409 | Card charges are off until library billing is switched on. Use store credit, or collect it at the counter. |
| `noCardSaved` | 409 | There's no card saved for Kiri Smith. Use store credit, or collect it at the counter. |
| `noFeeProduct` | 409 | There's no damage charge product to bill the card with yet. Run setup with memberships=plans. |
| `membershipsOff` | 409 | Lair Memberships isn't connected, so cards can't be charged right now. |
| `creditOff` | 503 | Shopify isn't connected, so store credit can't be used right now. |
| `creditShort` | 409 | Kiri Smith has $12.50 of store credit, so it can't cover $40. Nothing came off. (Or, balance unknown: Kiri Smith doesn't have $40 of store credit, so nothing came off.) |
| `noWayNow` | 409 | There's no way to take it from Kiri Smith now: not enough store credit and no card to charge. Collect it at the counter. |
| `settleNone` | 409 | That charge isn't waiting on a store credit check. |
| `settleSay` | 422 | Say whether the store credit came off: taken true or false. |
| `settleWait` | 409 | The Lair is still checking with Shopify. Try again in a few minutes. |
| `feeChangedMeanwhile` | (in `chargeNow.error`) | The charge changed while its notice was going out, so it wasn't taken now. |
| `cardFlagged` | 409 | Sam Jones's bank flagged their card, so it can't be charged until they update it. Use store credit, or collect it at the counter. |

A card Shopify refuses there and then is a 409 "Shopify wouldn't charge Visa ending 4242 (…). Nothing was charged."

Emails to members: welcome; payment didn't go through (and the fraud and damage charge versions); confirm your payment
(bank check); payment went through; plan changes; cancelled (paid up, ended now, or a payment in flight); membership
ended (games at home, damage charges to pay); damage charge notice (on the bill, on its own, at the counter, or taken
now) and a changed charge; charge cancelled (waived); a damage charge we couldn't take; and for damage charges taken
now: the receipt ("Paid: the $40 charge for Catan"), "We couldn't take the charge for Catan" (and where it goes
instead) and "Your bank wants you to confirm a $40 payment". Staff get the new member, failures for good, fraud,
disputes, games at home, and every billing problem above, including damage charges that couldn't be taken now, store
credit to check, a late payment, a charge paid twice, and a one-off contract that won't close (at most once a day each).

## 6. Theme work (separate repo, done 10 Oct)

Built as asked below (the plan of record), with what was learned on the way after it. Mo (10 Oct): "Can you make it
please thanks".

- **Membership product page:** the selling plan selector (Grab, Stash, Hoard: games at a time and the monthly price)
  and the terms by the button: monthly, cancel any time in My Lair, runs to the end of the month paid for, and damage
  or missing parts charged up to the game's RRP after an emailed notice: usually on the next bill after 7 days to sort
  it, but it can be taken straight away from store credit or the card saved for the membership. Shopify requires the
  terms to be clear before checkout.
- **My Lair → Library:** a membership card from `membership`: the plan and games at a time; the next bill and amount
  (and `nextTier`); the card, with "Update my card" (`POST /me/membership/card`); change plan (the three `plans`);
  cancel, or "Keep my membership" while `canResume`; `past_due` says borrowing is paused and when it's tried again
  (`retryAt`), `bankCheck` says to look for Shopify's email; `cancelling` shows the end date (`cancelAt`, or "decided by
  the payment in flight" when `null`); recent charges; damage charges with "Tell us we've got it wrong" (dispute).
  Someone with no membership sees the plans and a link to join.
- **Staff page:** a Memberships tab (`GET /memberships`: filters, counts, billing on or off, each member's plan,
  status, next bill, card, hold, games at home; Retry and End: at the end of the month or now) and a Damage tab
  (log one from a game at home or by title, the open list, waive, hold, put back, paid at the counter, new amount).
  The member page shows `member.membership`.
- **Damage tab, taking a charge now** (staff with Money): on a charge with `canChargeNow`, "Charge now" (`POST
  …/charge`, `use` auto), with "From store credit" and "On their card" as choices (the balance from `GET
  /members/:id/credit`, the card from `member.membership.card`); show the answer's `message`, and the 409's error as
  it is. While `charging`, show the payment's status ("Charging Visa ending 4242", "Waiting on their bank"); a payment
  `checking` gets "It came off" and "It didn't" (`POST …/settle`). The log form gets a "Charge it now" tick
  (`chargeNow`), sends its own `key` (one per form, so a double tap is one charge), and shows `chargeNow.message` or
  `chargeNow.error`. Paid ones say how (`paidVia`).
- **My Lair damage list:** `charging` says "Being paid now"; paid ones say how (`paidVia`: on your bill, from your store
  credit, on your card, at the counter).
- Load the `shopify-liquid-theme` and `gobgob-voice` skills for this work; errors that stop someone don't say "friend".

**What was built** (theme repo, `dice-goblin-2-theme`):
- `sections/library-plans.liquid`: each plan card's `selling_plan` setting is the plan's name (Grab, Stash, Hoard), so
  the Lair's plans are found by name whatever order Shopify lists them in (Simplee's, named differently, still fall back
  to their position). New settings `terms_heading` and `terms_summary` ("Good to know before you join": monthly, cancel
  in My Lair to the end of the paid month, plan changes from the next bill, damage charges after an emailed notice) sit
  just above the join button; the small print is "Renews monthly until you cancel. Cancel any time in My Lair." Both
  library templates (`product.membership`, `page.board-game-rental`) carry them, and their FAQs now say cancel and
  change plans in My Lair, how damage charges work, and what happens when a payment doesn't go through.
- `assets/lair-my-library.js` (+ css): "Your membership" (plan, status, next bill and what it comes to, the next plan,
  the card with Update my card, Change plan, Cancel asking first, Keep my membership, recent payments) and "Damage
  charges" (open ones first in the list, each with how it stands, "Tell us we've got it wrong" while it's a notice or
  due, and how a paid one was paid). A payment outstanding is said first on the plan card. A paused or ended membership
  replaces the join pitch with why. Home's Library card trusts GET /me's plan.
- `assets/lair-library.js`: a library game's page asks GET /me for the plan (members of the Lair's billing have no
  Simplee tags), shows Reserve for them, hides the borrow card's Join parts (`data-borrow-join`), and pauses reserving
  while a payment is outstanding. Without GET /me's `library` (an older Lair app) the tags still decide.
- `assets/lair-staff-memberships.js` (+ css), wired into `lair-staff.js`: the Memberships tab (Library, Members or
  Money), the Damage tab (Library or Money), a member page's "Library membership" (their membership with Retry and
  End, their damage charges, "Log a damage charge"), and "Damage charge" on each game at home in the Library tab.
  Charge now is offered only with `canChargeNow`; End isn't offered while a payment in flight decides the end date.
- `assets/lair-core.js`: the routes in section 3 as backend methods. `assets/lair-demo.js`: all of it in demo mode
  (`?membership=none|active|past_due|bank|cancelling|ending|ended|paused`, `?billing=off`, `?cardfail=1` for previews).
- Checks: `tools/qa/round10/memberships.mjs` in this repo (188 on the theme mock, phone and desktop, axe clean);
  Theme Check clean.

**Switch-over (Mo decides when):** the theme points every library template at the product handle
`board-game-rental-monthly` (Simplee's original). Rather than change six templates, the copy takes that handle: rename
the original's handle (say `board-game-rental-monthly-simplee`, without a redirect) and archive it, give the copy
`board-game-rental-monthly`, publish the copy (Online Store, and POS if wanted), then publish the theme. The library
terms page (`dice-goblin-board-game-rental-membership`, store content, shared with the live theme) still says to get in
touch to cancel or change plans, so it needs the new wording at the same time (section 10).

**Done 10 Oct** (Mo: "make joining online work and connected"), all but publishing the theme:
- Simplee's original (`7532313641063`) is `board-game-rental-monthly-simplee`, archived. The copy (`10244302012519`)
  is `board-game-rental-monthly`, active, on the Online Store only (Shopify allows a subscription-only product on
  online stores only), with the Lair's plans: Grab $30, Stash $60, Hoard $75. Its description now says cancel in My
  Lair, holds until midnight on the third day, the Wednesday 10pm postal cutoff, and damage charges emailed first.
- **Gotcha:** renaming a product's handle makes Shopify rewrite every theme setting that names it, in every theme. So
  the original's rename moved the templates' product settings and `shopify://products/…` links to
  `board-game-rental-monthly-simplee` (the archived product): four templates in Dice Goblin 2.0 and the live theme's
  `page.board-game-rental.json` ("Join Today!" twice). The branch still says `board-game-rental-monthly`, so Dice Goblin
  2.0 is right again once it's back in step with the branch. The live theme can't be written through the API, so a URL
  redirect sends `/products/board-game-rental-monthly-simplee` to `/products/board-game-rental-monthly`. Next time, give
  the product the new handle in the templates first, or expect the rewrite.
- The terms page has section 10's wording, dated 10 October 2026. The live theme's terms template
  (`page.rent-terms-and-conditions`) shows its own old text (dated 5 March) rather than the page, so the new wording
  shows on Dice Goblin 2.0; its short version now matches too.
- Joining needs the theme's plan picker: the live theme (Booster) only posts `id` and `quantity`, so its product page
  can't join (true since Simplee's plans went). Joining works on Dice Goblin 2.0, in preview now and for everyone once
  it's published.
- Leave Simplee installed until Dice Goblin 2.0 is live: the live theme's layout includes Simplee's
  `simplee-memberships` snippet.
- Shopify's GitHub sync stopped taking pushes to `dice-goblin-2-theme` after round 12 (last synced 9 Oct 15:56 UTC);
  Online Store › Themes › Dice Goblin 2.0 › Reset to last commit (and View logs) brings it back in step.

## 7. Setting it up (Mo)

1. **Lair Memberships** (done): made in the Dev Dashboard and installed, with `read_own_subscription_contracts`,
   `write_own_subscription_contracts`, `read_customer_payment_methods`, `read_orders`, `write_products`,
   `read_customers` and `write_customers`. Its client secret is the Worker secret `MEMBERSHIPS_CLIENT_SECRET` (never in
   the config table or GitHub).
2. **Config table** (done 9 Oct): `MEMBERSHIPS_CLIENT_ID` (the app's client ID); `MEMBERSHIPS_PRODUCT_ID`, the
   membership product the plans go on: a copy of Simplee's "Board Game Rental Membership" (draft, subscription only,
   so Simplee's plans don't sit beside the Lair's); `MEMBERSHIPS_SIMPLEE_TAGS` = `off` (Simplee is going: its only
   subscription was Mo's own test); `MEMBERSHIPS_BILLING` = `off` until the tests pass. `MEMBERSHIPS_FEE_VARIANT_ID`
   only if you make the damage charge product yourself.
3. Open `/setup?key=YOUR_SETUP_KEY&memberships=plans`: it checks the permissions, makes the plans (once) and puts them
   on the product, makes the damage charge product (once) and the webhooks. `membershipsSetup` says what it did. Or,
   without the key, queue the owner's job `memberships.setup` (a row in the config database's `admin_jobs`, kind
   `memberships.setup`, payload `{}`): the cron runs it within 10 minutes and writes the same answer into the row.
4. **Test** (section 8; on the real store, since the new site and the Lair aren't live yet: Mo, 9 Oct), then set
   `MEMBERSHIPS_BILLING` = `on`.
5. **Switch over** (done 10 Oct, section 6, apart from publishing Dice Goblin 2.0 and uninstalling Simplee): publish
   the copy (the theme's product page shows the Lair's plans), and archive Simplee's original product. The copy takes
   the original's handle first, and the terms page gets its new wording (sections 6 and 10). On 10 Oct the original
   product already had no plans on it, so nobody could join through the live site until then. Once Dice Goblin 2.0 is
   published, uninstall Simplee in Shopify admin (Shopify cancels its subscriptions and removes its plans 48 hours
   later).

Switching `MEMBERSHIPS_BILLING` off at any time stops all charging at once (payments already with Shopify finish). When
it's switched back on, months missed meanwhile are skipped, not billed late (staff get the list).

## 8. Check before billing goes on

Not confirmed by Shopify's documentation, so check these with test payments:
- **The first renewal:** a contract made at checkout has its first renewal about a month on (cycle 1's date). If
  Shopify marks cycle 1 billed by the checkout, the Lair takes cycle 2, so check that date too (staff hear if it's
  more than 35 days after joining).
- **A second damage charge after cancelling** bills the next cycle before its date. If Shopify refuses that, the
  charge goes to the counter after three daily tries (staff hear).
- **Renewal orders:** whether Shopify sends its order confirmation for them.
- **A bank check:** that Shopify emails the member, and what happens when it's never done.
- **A card update** through Shopify's email: whether the same payment method changes (`customer_payment_methods/update`)
  or a new one is made (`/create`); both are handled.
- The draft mutations used for plan changes and damage charge lines are deprecated in 2026-07 (no removal date yet);
  2026-10 has replacements.
- **A damage charge taken now on a card:** that Shopify takes the one-off contract (no shipping on it, its one bill due
  within the hour) and bills its cycle 1 straight away; whether the member gets Shopify's order confirmation for it;
  and that the contract's cancel webhook changes nothing. If Shopify refuses the bill (a cycle error), staff hear and
  nothing is charged.
- **Store credit taken now** with an answer lost: finding it again reads the account's debits, which needs the Lair's
  own app to have `read_store_credit_accounts` (approved in Shopify admin); without it staff are asked to settle it.

## 9. What was built

- `src/memberships.js`: Lair Memberships' Shopify calls (`MembershipsAdmin`) and the Lair's side (contracts, webhooks,
  billing, retries, cancelling, damage charges, staff, setup, emails).
- `src/lair.js`: the round 10 migration (tables `memberships`, `membership_charges`, `damage_charges`,
  `damage_payments` (damage charges taken now), `membership_events`), the routes, the library plan from memberships
  (holds, scans, GET /me, the staff page), and maintenance. Round 10 grew in place before it went live, so a store that
  ran an earlier copy of it gets the tables and columns added since (`ROUND10_LATE_COLUMNS`) when it starts.
- `src/index.js`: `/webhooks/memberships`. `src/config.js`: the `MEMBERSHIPS_*` keys. `src/shopify.js`: a second app's
  login (its own token key); store credit refusals marked (`error.refused`), and an account's latest debits
  (`storeCreditDebits`).
- `test/round10-memberships.test.js`: a fake Shopify that charges what each cycle's edit says, can lose an answer or
  get a webhook in first, and every rule above.

## 10. The library terms page, new wording (for the switch-over)

The page "Library membership terms" (`/pages/dice-goblin-board-game-rental-membership`) is Shopify content, not the
theme, and the live theme links to it too, so it changes when Mo switches over. Replace these sections and keep the
rest as it is. The date at the top becomes the switch-over date.

**Billing**
- Your membership is a monthly subscription. You pay for your first month when you join, and it renews automatically
  each month until you cancel. There's no minimum term.
- Your card is saved securely with Shopify for your monthly payments and any charges for missing pieces or damage
  (below). We never see your full card number.
- If a payment doesn't go through, we'll email you and borrowing pauses until it's sorted. Update your card in My Lair
  and we'll try again. We also try again after 3 days and after 7 days. If it still doesn't go through, your membership
  ends.
- We don't refund part-months. Nothing in these terms affects your rights under the Consumer Guarantees Act.

**Missing pieces and damage**
- Check the contents when you borrow a game. Tell us at the counter if a piece is missing, so it isn't charged to you.
  Borrowing by post? Tell us as soon as you open the parcel.
- If pieces go missing or a game gets damaged while it's with you, we may charge you to fix or replace it, up to the
  game's RRP. If a game is lost or can't be played any more, we may charge up to its RRP.
- We email you an itemised notice first. Usually the charge goes on your next monthly payment 7 days later, so there's
  time to bring the missing pieces back, or to tell us in My Lair if you think we've got it wrong (it waits while we
  sort it out). We can also take it straight away from your store credit or the card on your membership.
- If your membership has ended, we can still charge it to the card you used for your membership, or you can pay at the
  counter.
- Our staff can waive any of these charges.

**Cancelling and changing plans**
- Cancel any time in My Lair, under Library. Your membership runs to the end of the month you've paid for, and there
  are no more payments. You can change your mind until then.
- To move to a bigger or smaller plan, pick it in My Lair. The new plan and price start from your next payment.

**Late returns and ending your membership** (unchanged, apart from the first words)
- While your membership is active, nothing is ever late. When your membership ends, please return every game within 7
  days. Games still out after that may be charged up to their RRP.

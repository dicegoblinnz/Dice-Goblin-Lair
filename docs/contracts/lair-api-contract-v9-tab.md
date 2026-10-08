# Lair app API: round 9, the running tab and monthly accounts [tab] (9 Oct 2026)

**Changes only**, on top of v8 and everything before it; where they disagree, this file wins. Money in cents, times in
ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.
Backend branch `r9-tab-api`, theme branch `r9-tab`.

Mo (9 Oct): "I want the games booked in through GM games or events etc to tie to your QR code and falls into your
account. And arguably falls into your tab and you will have a running tab with future events and when you settle the
tab you cns pay for it day by day or if you like you can save it to pay it off once a month either up front or
compiled. The idea is to track it all in the Shopify." And for staff: "increase credit limit or decrease it".

## 1. Rules

- **One running tab per member**, worked out every time from their bookings, seats, sign-ups and tabs (nothing copied):
  - **owed**: weekly seats owed (round 5's rule, for everyone); what they checked in for **today** and haven't paid; their
    tab **today** (open or at the counter); and, from a **monthly period** of their account, what they checked in for or
    put on a tab then. Only from `tabFrom` (the first start of round 9, `meta` key `tab-from`, like `owed-from`), so old
    records never start nagging. A one-off no-show is never owed (just recorded, as before).
  - **coming up**: their bookings, seats and sign-ups still to come and not checked in (up to 30, 120 days ahead), with
    what's left to pay and how it's settled.
- **Pay each visit (the default, no account row): nothing changes at the counter.** The POS gets the same rows and lines
  as before (an earlier visit left unpaid is not owed for them, so nothing they paid by hand can be charged twice).
- **Monthly account** (staff switch it on, with a credit limit): what they check in for, or put on a tab, while it's
  monthly goes on their account and rolls over. Switching on starts a period `[from, null]`; back to pay each visit ends
  it (`[from, until]`), and whatever is owed from it **stays owed** (the POS and the Accounts tab keep listing it) until
  it's paid. Periods are kept in `tab_accounts.periods`.
- **Credit limit:** a new table booking, game spot, weekly seat (join every session), event sign-up paid at the counter
  or tab item that would take `owed + new > limit` is refused (409, below). Paying online now (an event's checkout) puts
  nothing on the account, so it's never refused. Staff making a booking for someone (walk-ins, `staffOverride`) are
  never refused; adding a player on the staff page answers `accountWarning`.
- **The monthly bill:** the first maintenance run on or after the 1st (Lair midnight; NZDT and NZST both tested) makes,
  for each account that was monthly **before that 1st** and owes anything from before it, one bill (`kind 'month'`,
  `month 'YYYY-MM'` = the month before; unique per member and month). Switched on mid-month: the first bill is the next
  1st, so nobody is billed by surprise. Then it's emailed. A run that can't reach Shopify leaves the bill open without a
  link; a later run (5+ minutes on) makes the link and sends it. An open bill gets **one** friendly reminder 14 days
  after it was sent.
- **One open bill a member, and nothing on two:** any new bill cancels (voids) the open one first and deletes its draft
  order. A bill stays open only while everything on it is still owed **at the amount billed**:
  - all of it paid (at the counter, or by hand on the staff page) → the bill is `paid` (`paidHow 'counter'`) and its
    draft order deleted (`deleteDraftIfOpen`), so it can't be paid twice;
  - some paid, waived, changed (people, a tab edited), or a check-in undone → the bill is `void` (`voidReason
    'part-paid'` or `'changed'`), its draft deleted, and what's still owed stays on the account for the next bill or
    "Pay online now".
- **The draft order** is the customer's (`purchasingEntity.customerId`), tagged `lair-bill`, `_bill` on the draft and on
  every line. Bookings, seats and sign-ups are custom lines "Table for 4 · Thu 3 Sep · SJ-OWLBEAR-17" (or the game's or
  event's title) tagged `_booking`; tab items are their product variants at the tab's prices (`priceOverride`) tagged
  `_tab`, with a $0 "Collected at the Lair" shipping line. If Shopify won't take a variant, every line goes custom.
- **Paid online** (`orders/paid` from the bill's own draft: Shopify is asked which order the draft became, as for event
  checkouts): each `_booking` line is recorded like any payment (payments row, paid amount), each `_tab` marks that tab
  paid, the bill is `paid` (`'online'`). No booking confirmation email goes out. A tab already paid by another order is
  flagged to staff ("A tab was paid twice"); bookings keep round 4's "Paid twice" flag.
- **Paid at the counter:** for a member on an account, `/pos/scan` and `/pos/checkin-member` list what's owed on the
  account from earlier days as owed rows (`owed: true, onAccount: true`, each with its `line`), after their weekly seats:
  bookings as "Owed: Table T3 (Thu 1 Oct)" tagged `_booking`, an earlier day's tab as "Tab: Thu 1 Oct (3 things)" tagged
  `_tab` (the tile adds its `_booking` stand-in `TAB-XXXXXX`, which matches nothing). "Add everything to cart" takes them
  with today's rows and tab; when that sale is paid the bill is reconciled (above).
- **Up front = store credit** staff add (team's button). Shopify uses it at checkout and the POS. The Lair only shows it.
- **Every payment is a Shopify order.**
- Adoption by email: accounts and bills are only ever made for a member (by customer ID), so there's nothing to adopt.

## 2. Views

**Running tab item:** `{ type: 'booking'|'join'|'tab', id, ref, kind: 'table'|'spot'|'seat'|'event'|'tab', title, when,
end, people, amount (what's left to pay), status: 'owed'|'booked'|'held', settle: 'day'|'account'|'online'|'paid',
bill (the open bill's id or null), onBill, weekly, today }`. A tab adds `things` and `tabStatus`; its `ref` is
`TAB-XXXXXX`. Titles: a table is "Table T3" ("Game table at <event>" for a game spot), a seat its game, a sign-up its
event, a tab "Your tab today" or "Your tab, Tue 15 Sep".

**`account`** (GET /me, and the staff member page):
`{ billing: 'visit'|'monthly', creditLimit, owed: { total, items }, comingUp: { total, items }, bill, available,
overLimit }`. `owed.total` includes the open bill's items (each says `onBill`), so `available = creditLimit − owed.total`
is the limit less what's owed and the open bill, counted once (`null` when paying each visit). `comingUp.total` leaves out
places paid online already. Staff also get `note, setBy, setAt, monthlySince, bills (newest first, up to 24), warning`.

**Bill:** `{ id, kind: 'month'|'now', month, label ("September 2026", or "To Fri 9 Oct"), total, items: [{ type, id, ref,
kind, title, when, people, amount }], status: 'open'|'paid'|'void', invoiceUrl (open only), createdAt, paidAt, paidHow,
words }`. words: "Sent Thu 1 Oct. Pay online any time, or at the counter next time you're in." / "Paid online on Fri 2
Oct. Thanks, friend." / "Cancelled. What was on it is still on your account." Staff add `draftOrderId, orderId,
voidReason ('replaced'|'staff'|'part-paid'|'changed'), madeBy, emailedAt, remindedAt, voidedAt, ageDays`.

## 3. Routes

| Route | Who | Body | Answer |
|---|---|---|---|
| `GET /me` | member | | adds `account` (section 2) |
| `POST /me/account/pay` | member | | `{ bill, invoiceUrl, account }`: a fresh bill (`kind 'now'`) for everything owed, replacing an open one; the open one when nothing changed |
| `GET /members/:customerId` | staff | | `member.account` (staff view) |
| `POST /members/:customerId/account` | staff | `{ billing?, creditLimit? (cents), note? }` | `{ account, said, before: { billing, creditLimit } }` |
| `GET /accounts` | staff | | `{ accounts: [{ customerId, name, code, billing, creditLimit, owed, owedCount, available, overLimit, bill, lastPaid: { at, total, how } }], now }`: monthly accounts and anyone still owing from one; over the limit first, then at it, then most owed |
| `POST /accounts/:customerId/bill` | staff | | `{ bill, emailed, said, account }`: make and email a bill now (`kind 'now'`) |
| `POST /bills/:id/void` | staff | | `{ bill, account }` (the page asks first) |
| `POST /bills/:id/resend` | staff | | `{ bill, emailed: true, said }` |
| `GET /floor` | staff | | adds `monthlyAccounts: [customerId]` ("On their account") |
| `POST /checkin` (member code) | staff | | adds `account: { billing: 'visit' }` or `{ billing: 'monthly', creditLimit, owed, available, warning }` |
| `POST /games/:id/players` | staff | | adds `accountWarning` when that member's account is at or over its limit |
| `POST /pos/scan` (member) | POS | | adds `account` (as `/checkin`); `rows` adds the account's owed rows from earlier days |
| `POST /pos/checkin-member` | POS | | `rows` and `lines` add the same owed rows |
| `orders/paid` | Shopify | | adds `bills: [id]` paid |

`said` (POST /members/:id/account), word for word: "Sam is on a monthly account now, with a $100 limit. What they check
in for from now goes on their account, and their bill comes on the 1st." · "Sam's credit limit went from $100 to $150." ·
"Sam pays each visit now. They still owe $29 from their account. That stays owed until they pay it, online or at the
counter." · "Saved." Plus the warning when at or over the limit: "At their $100 limit: $100 owed." / "Over their $100
limit: $120 owed." `said` (bill now): "Bill for $29.00 emailed to sam@example.com." (resend: "… again."); with no
link yet: "Bill made for $29.00, but Shopify didn't make its payment link yet, so it wasn't emailed. The Lair tries again
in 10 minutes, then sends it."; with no email: "Bill made for $29.00. There's no email for Sam Jones, so the bill can't be
sent. Add one to their profile, or give them the link." (the staff page shows an open bill's Payment link).

### Errors, word for word
- Staff routes: 403 "Staff only. Log in with your staff account."
- 404 "No member with that customer ID." · 404 "That bill could not be found."
- 422 "Pick pay each visit or a monthly account." · 422 "A credit limit is $0 to $5,000." · 422 "Set a credit limit for a
  monthly account, like $100."
- 409 "Sam Jones pays each visit, so there's no account to bill. Switch them to a monthly account first."
- 409 "Sam Jones doesn't owe anything right now, so there's nothing to bill."
- 409 "That bill is paid already." · 409 "That bill was cancelled. Make a new one with Bill now."
- Resend: 409 "There's no email for Sam Jones, so the bill can't be sent. Add one to their profile, or give them the link." ·
  409 "Emails aren't set up yet, so the bill can't be sent."
- 503 "Shopify didn't make the bill's payment link just now. Try again in a minute."
- Member: 401 "Log in to see your account." · 409 "You pay each visit, so there's nothing to pay online. Show your
  member code at the counter and we'll ring it up." · 409 "There's nothing on your account to pay right now." · 503
  "Online payment isn't working right now. Pay at the counter next time you're in, or try again in a minute."
- The limit (409), on `POST /bookings`, `/events/:id/join` and `/events/:id/reserve` paid at the counter,
  `/games/:id/join-series` and `POST /tab`:
  - at or over it: "Your Lair account is at its $100 limit. Pay your bill online or at the counter, then book again."
  - this would cross it: "That would take your Lair account over its $100 limit ($5 left). Pay your bill online or at
    the counter, then book again."
  - the ending is "book again" (bookings, game spots, weekly seats), "sign up again" (events) or "add to your tab again".

## 4. Emails
- **The bill** (to the member's verified account email, else their Lair email): subject "Your Lair bill for September:
  $64.00" (a bill made on request: "Your Lair bill: $64.00"); each item "Thu 3 Sep — Table for 4 (SJ-OWLBEAR-17):
  $40.00", the total, a **Pay online** button (the invoice URL), then "Or pay at the counter next time you're in: show
  your member code and we'll ring it up." and "Store credit on your account is used when you pay."
- **The reminder** (once, 14 days after it was sent): "A friendly reminder: your Lair bill for September ($64.00)", with
  the same button and "Paid it already? Thanks, friend. You can ignore this one."
- **Staff:** "Paid twice: a tab (TAB-XXXXXX)" when a bill pays for a tab another order already paid.

## 5. Stored (tab appends ONE entry to `MIGRATIONS`; find it by `tab_accounts`)
- `tab_accounts (customer_id PK, billing, credit_limit, note, periods JSON, set_by, set_at, created_at, updated_at)`
- `tab_bills (id PK, customer_id, kind, month, items JSON, total, status, draft_order_id, invoice_url, order_id, paid_how,
  void_reason, made_by, created_at, emailed_at, reminded_at, paid_at, voided_at, updated_at)`, unique
  `(customer_id, month) WHERE kind = 'month'`.
- `meta` key `tab-from`.
- Code: `src/tab.js` (methods copied onto `Lair.prototype` at the end of `src/lair.js`), `ShopifyAdmin.createBill`.

## 6. Staff routes and permissions

| Route | Permission |
|---|---|
| `GET /accounts` | `money` |
| `POST /members/:customerId/account` | `money` |
| `POST /accounts/:customerId/bill` | `money` |
| `POST /bills/:id/void` | `money` |
| `POST /bills/:id/resend` | `money` |

Each is guarded with `this.requireStaff(who); // perm: money`. Staff page tab: id `accounts`, label "Accounts", perm
`money` (`assets/lair-staff-accounts.js`). The member page's "Tab and account" section (`renderMemberAccount()`) needs
`money` for its buttons; reading it comes with the member page.

## 7. Contract notes (choices made)
- "available = limit − owed − open bill": the open bill's items are owed items, so they're counted once (`owed.total`).
- The limit counts what's owed, not what's coming up (as the spec's `available`); a new item's own price is added, so
  "$5 left" refuses a $10 table.
- A pay-each-visit member's earlier visit left unpaid is **not** owed (it may have been paid by hand at the counter);
  only today's, weekly seats, and a monthly period's are. That keeps the counter exactly as before for them.
- "Bill now" and "Pay online now" are for monthly accounts only (a pay-each-visit member pays at the counter).
- An account switched on mid-month gets its first bill on the next 1st (nothing emailed by surprise).
- A void bill's link that gets paid anyway (a race while it was replaced) still records the payments; the newer bill is
  then reconciled as paid.
- The status page's proxy note (`known` route list in `fetch()`) doesn't list `accounts` and `bills`: left alone to keep
  merges small (cosmetic: such a call notes `proxyMiss`).

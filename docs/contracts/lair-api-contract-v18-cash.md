# Lair app API: cash at the counter (17 Oct 2026)

**Changes only**, on top of v18-open-seats and everything before it; where they disagree, this file wins. Times in ms
(UTC), shown in Lair time (Pacific/Auckland); money in cents. Backend: `src/cash.js` (the requests, taking the cash, the
Shopify order), `src/lair.js` (routes, `GET /me`, `GET /floor`, maintenance) and `src/shopify.js`
(`createPaidLinesDraft`). Theme: My Lair's bill card (`assets/my-lair.js`), the staff page (`assets/lair-staff.js`),
`assets/lair-core.js` and the demo (`assets/lair-demo.js`). Tests: `test/round18-cash.test.js`; browser checks:
`tools/qa/round18/cash.mjs`.

Mo (17 Oct, 12:49am): "cash I never thought about it, we should have something made for that. But I don't want to let
it happen so easily on the tablet since the tablet is admin signed in because I don't want to pay for more shopify to
get staff added. So we should have a button to push a client to paid in cash and admin or staff checks the button on
their account to clear it. A little more work on the staff side but should be fine." He picked: build it now, and
record it in Shopify as a paid order.

## 1. Rules

### 1.1 Asking to pay with cash (members)

- A logged-in member taps **Pay with cash** on their bill in My Lair (their phone, or the shop's tablet). The Lair makes
  a request for what they'd pay at the counter now, exactly as My Lair's bill shows it: today's bookings, seats and
  sign-ups with something left to pay (confirmed or checked in), anything owed from earlier, and today's tab (open, or
  in the till's cart).
- Asking pays nothing and changes nothing else. It only tells staff, who take the cash and tick it off (1.2). Their tab
  can still be added to.
- One request waits for each member each day. Tapping again (**Update**, when the bill's changed) brings it up to date.
  A request still waiting from another day ends when they ask again.
- **I'll pay another way** ends it.
- Not on a monthly account (`409 monthly`): everything goes on their bill, which they pay online or at the counter.
- Nothing to pay: `409 nothing`.

### 1.2 Taking the cash (staff)

- Staff with Check-in or Money (the main account always) see today's waiting requests on the staff page, under check-in,
  first asked first: the member's name and code, what's on the bill and the total.
- **Got the cash** takes two taps and sends the total staff were shown (`expect`). The Lair then:
  1. checks the member in as the till's "Add everything to cart" does (`posCheckInMember`: today's sessions checked in,
     their saved passes used, stamps as usual);
  2. works out what's left to pay: a line for each of today's sessions and anything owed, as the till rings them up,
     and today's tab;
  3. when that comes to `expect`, records it all paid from this request: a payment for each line with order
     `cash:<id>` (once per line, as a paid order's lines are, so nothing's paid twice), the tab paid, and monthly bills
     kept true. The request is paid, with who took it;
  4. when it doesn't (a session pass took some off at check-in, or the tab changed), pays nothing. The request shows
     the new total (`409 changed`) for staff to take and tap again;
  5. with nothing left to pay, ends the request (`409 nothingNow`).
- A request from another day can't be taken: it ends (`409 otherDay`), and they tap Pay with cash again.
- **Not paid** (two taps) ends a waiting request. Nothing's paid.
- Two staff tapping at once: one takes it, the other is told it's been paid already (`409 done`).

### 1.3 Its Shopify order

- Once the cash is taken, the Lair makes a paid Shopify order for it in the background, so Shopify's sales, stock and
  the member's spend include cash:
  - a draft order for the customer, tagged `lair-cash` and `cash`, noted "Paid in cash at the Lair counter, taken by
    Ruia (cr_…).", with the marker attribute `_lair_cash: <id>` and no automatic discounts;
  - bookings, seats, sign-ups and what's owed as custom lines at what each paid (taxable, no shipping);
  - the tab's things as their products at the tab's price (`priceOverride`), so stock comes off, with a $0 "Collected at
    the Lair" shipping line;
  - completed as paid (`draftOrderComplete`), as store credit's damage orders are (`src/memberships.js`).
- Never twice: it's claimed before Shopify is asked, and a try that may have made one looks for it by its marker first.
  It's tried again after 10 minutes, 30 minutes, 1 hour, 3, 6 and 12 hours and a day, then has one last look an hour
  later. After that, staff are emailed "Cash with no Shopify order: <name>" to make it by hand, with the draft's link
  when there is one. While Shopify isn't connected, it waits.
- If Shopify's total isn't the cash taken (the shop's tax or discount settings), staff are emailed "A cash order doesn't
  match: <name>".
- The order has no booking codes and no `_booking` or `_tab`, so orders/paid pays nothing twice. Like any paid order,
  it counts the member's spend (once per order), and session passes or session gifts on the tab (`LAIR-PASS-n`,
  `LAIR-GIFT-n`) are made from it.
- The cash is taken and everything's paid either way: only Shopify's record of it waits.

## 2. Routes

### 2.1 `POST /me/cash` (logged in)

→ `{ cash: { id, status: 'waiting', total, items: [{ kind: 'booking' | 'join' | 'tab', id, ref?, title, amount,
things? }], at, paidAt: null } }`. An owed item's `title` starts "Owed: "; the tab's is "Tab: 2 things", with `things:
[{ title, qty }]`. Errors: `401 login`, `409 monthly`, `409 nothing`.

### 2.2 `POST /me/cash/cancel` (logged in)

→ `{ cash: null }` (whether or not one was waiting). Errors: `401 login`.

### 2.3 `POST /cash/:id/paid { expect }` (staff with Check-in or Money)

`expect`: the total staff were shown, in cents (the theme always sends it; left out, it's taken at whatever it comes
to). → `{ cash, notices }`, `cash` as staff see it (2.5) and `notices` the check-in's (a pass that couldn't be used,
say). Errors, in this order: `403` (not staff, or no Check-in or Money); `422 expect`; `404 noRequest`; `409 done`;
`409 otherDay`; `409 nothingNow`; `409 changed`.

### 2.4 `POST /cash/:id/cancel` (staff with Check-in or Money)

Not paid. → `{ cash }` (staff view). Ending one that's ended already changes nothing. Errors: `403`; `404 noRequest`;
`409 done` (it's been paid).

### 2.5 What's added to reads

- `GET /me` adds `cash`: today's waiting request (2.1's shape), or `null`.
- `GET /floor` adds `cash` for staff with Check-in or Money: today's waiting requests, first asked first, each with
  `customerId`, `name`, `code` (their member code), `by` (who took it, a first name), `order` (`{ id, name }` or null)
  and `orderStatus` (`due`, `making`, `failed`, `made`, `stopped` or null).
- The 10-minute maintenance's result adds `cashOrders: { looked }` when it looked at any.

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `login` | Log in to pay with cash. |
| `nothing` | There's nothing to pay right now. |
| `monthly` | You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter. |
| `noRequest` | That cash payment could not be found. |
| `done` | That's been paid in cash already. / They changed their mind, so there’s nothing to take. |
| `otherDay` | That one was from another day. Ask them to tap Pay with cash again. |
| `nothingNow` | There's nothing left to pay now, so there's no cash to take. |
| `changed` | It's $27.00 now (a session pass took some off, or their tab changed). Take $27.00, then tap Got the cash again. |
| `expect` | expect is the amount you were shown, in cents. |

(`CASH_WORDS` in `src/cash.js`; the demo has the same.)

Staff emails: "Cash with no Shopify order: <name>" (title "A cash order that needs making by hand") and "A cash order
doesn't match: <name>".

## 4. Storage

The table `cash_requests` (made when missing, in `migrate`): `id` (`cr_…`), `customer_id`, `day` (Lair date), `status`
(`waiting`, `paid` or `ended`), `total`, `items` (JSON, as 2.1), `lines` (JSON, the Shopify order's lines, fixed when
paid), `created_at`, `updated_at`, `paid_at`, `by` (the staff member's customer id), `by_name`, `ended_at`, `ended_by`
(`them`, `staff`, `another day` or `nothing left`), and the order's `order_status`, `order_tries`, `order_next_at`,
`order_draft`, `order_sent_at`, `order_id`, `order_name` and `order_error`. Indexes on `(day, status)`, `(customer_id,
status)` and `(order_status, order_next_at)`.

## 5. The theme

- **My Lair, the bill card.** Beside Show my Goblin card: **Pay with cash** (not on a monthly account, and only with
  something to pay). Once tapped, the card's badge is **Paying cash** and its heading **Paying cash: $27**, with "Hand
  $27 to one of the team at the counter. They’ll tick it off, and you’re all paid.", Show my Goblin card and **I’ll pay
  another way**. When the bill changes, it says "Your bill’s $30 now. Tap Update so the team see the new total." with
  **Update**. Focus goes to the card's heading, and the change is announced ("Paying cash: hand $27 to one of the team
  at the counter." / "No worries. Pay at the counter however suits you."). While one's waiting, the page asks the Lair
  every 12 seconds, so the card shows the bill paid once staff tick it off.
- **The staff page.** Under check-in, for staff with Check-in or Money: **Paying cash** with a count, "Take the cash,
  then tap Got the cash: it checks them in and marks it all paid.", and a card for each request (name, "$27 cash", what's
  on the bill, "Asked at 12:58pm · RT-WALRUS-4"), with **Got the cash: $27** ("Tap again: got $27") and **Not paid**
  ("Tap again: not paid"). Toasts: "Paid in cash: $27 from Ruby Tane. They’re checked in, and Gobgob’s putting it in
  Shopify." (with any check-in notices), "Cleared Ruby Tane’s cash payment. Nothing was paid.", and the Lair's words
  when it's refused (a new total shows on the button).
- The demo does the same, with "#DEMO" for the order.

## 6. Good to know

- The shop's tablet is logged in to Shopify POS as the owner, so its own checkout can still take a "cash" payment that
  nobody checks. This feature doesn't change the POS: cash should go through Pay with cash and staff.
- A request left waiting at closing just stops showing the next day.

# Lair app API: round 15, everything on the tab, locked 24 hours before [tab] (12 Oct 2026)

**Changes only**, on top of v9-tab and everything before it; where they disagree, this file wins. Money in cents, times
in ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.
Backend branch `r15-tab`, theme branch `r15-theme`.

Mo (12 Oct): "why am I getting a new QR code when I sign up to a game or event?. Can you please put the game inside my
tab without the ability to remove it as this will be my running tab ... require staff to remove items from tabs if there
was any issues. But signing up to a game adds it to your tab and if you don't cancel within 24 hours of the game it is on
your account and cannot be removed and the same will be for anything else you sign up to. Don't create a new QR code to
pay make it live inside each person's tab ... Including table booking etc. All transactions that are not shop retail
Shopify sales things should be the same so make it all always go back to your tab that you will hold and the money will
only be available to be paid on the day or if you prefer you can choose to pay for more than once at once etc."

## 1. Rules

- **Everything goes on the tab.** A table booking, a TTRPG seat (one-off or weekly), an event sign-up and an event game
  table are paid at the counter on the day (or a few at once), never through a checkout of their own and never with a
  code to show: the person gives their name (or shows their member card from My Lair). A ticket sold as a Shopify
  product is a shop sale, as before.
- **The cutover:** `lockFrom`, the first start of round 15 (`meta` key `lock-from`, like `owed-from` and `tab-from`).
  What was booked before it keeps the rules it was booked under (below).
- **Cancelling it yourself:** something booked or signed up for from `lockFrom` with something to pay (`amount > 0`) can
  be cancelled online until `cancelUntil = start − refundHours` (the theme's `lair_refund_hours`, 24). From then it's
  **locked in**: it stays on the tab whether or not they come, and only staff take it off (cancel, or waive). Something
  booked inside those 24 hours is locked at once (the pages say so before it's booked).
  - Not locked (cancelled online until it starts, as before): a free one (`amount` 0), anything booked before
    `lockFrom`, and a weekly regular's seat Gobgob saved for them inside the 24 hours (a seat that came free late, a
    session the GM added late). The seat that joining a weekly game books is their own choice, so it's locked like a
    one-off seat.
  - An event sign-up can't be cancelled online once it has started (`409`, `started` below).
- **Owed:** anything of theirs from `lockFrom` (a table, a seat, a game table, a sign-up) that has ended unpaid, not
  cancelled and not waived is **owed**, whether or not they came (no-shows too). Round 5's weekly seats are owed as
  before. A walk-in table (staff seat someone at a free table) and a GM's own table never are; someone staff check in
  at an event's door (`POST /events/:id/attend`) is signed up like anyone else. Before `lockFrom`, a one-off no-show is
  never owed (as v9-tab).
- **Staff take things off the tab** by cancelling them (any time) or waiving them (`waived`, the Money permission; event
  sign-ups now have `waived` too).
- **Paying for a few at once:** at the counter the POS already takes every owed row's line in one sale; staff can also
  mark several things paid at once on the staff page (§2.4), coming up or owed.

## 2. Routes

### 2.1 Views

`cancelUntil` (ms, or `null` once it's cancelled, over or checked in) and `locked` (boolean) on:
- a booking or seat as its own person sees it (`POST /bookings`, `POST /events/:id/reserve`, `POST /bookings/:id/update`,
  `GET /me` `bookings[]` and `seats[]`),
- a sign-up (`POST /events/:id/join`, `GET /me` `joins[]`, staff sign-up views),
- the running tab's `comingUp.items[]` (`GET /me` `account`, the staff member page).

`owed` and `waived` on sign-ups as on bookings (`joinView`, check-in rows: `type: 'join'`, `owed: true` once it's owed).
`GET /floor` `features.payOnline` is always `false`. Event sign-ups and game tables never come back `held` or with a
`checkoutUrl` (a checkout opened before round 15 still finishes as v4).

### 2.2 Cancelling

- `POST /bookings/:id/update { status: 'cancelled' }` (their own) and `POST /events/joins/:id/cancel` (their own):
  `409 locked` once it's locked in. Staff are never refused.
- `POST /series/:id/leave` (the regular): seats that are locked in stay (on their tab); the rest are freed. Answer
  `{ ok, cancelled, kept: [{ id, ref, start, end }], notice? }`; `notice` is `keptSeat` when one is kept. The GM's email
  says which seat stays. Staff stopping a regular (`{ customerId }`) free every seat, as before.

### 2.3 Owed at the counter

`/pos/scan`, `/pos/checkin-member`, `POST /checkin` (a member code) and `GET /me` (`dueNow`, `account.owed`) list what's
owed (bookings and sign-ups, oldest first, each once) as owed rows with their line: "Owed: Table T5 (Thu 1 Oct)",
"Owed: Trivia night (Fri 2 Oct)". Something owed that ended today is with the owed rows, not today's (one that's theirs
by email alone stays among today's). On a monthly account owed rows carry `onAccount: true`. `account.owed.items[]`
from these rows have `owedRow: true`. `GET /members` (`owed`, `owedCount`, `sort=owing`, `owing=1`) and a member's page
count the same rows (before, only round 5's weekly seats).

### 2.4 `POST /members/:customerId/paid { items: [{ type: 'booking' | 'join', id }] }` (staff)

Check-in or Tables for bookings and seats, Check-in or Events for sign-ups. Marks up to 40 of that member's things paid at
once (what's left on each counts as paid, as Mark paid does for one). Answers `{ paid: [{ type, id, ref, amount }],
total, account }` (the staff member page's account). Errors: `403` not staff; `422 pickSome` (nothing ticked); `409
notTheirs` (not theirs, cancelled or a GM's own table); `409 nothingDue` (nothing left to pay on what was ticked). Open
bills are reconciled.

### 2.5 Waiving a sign-up

`POST /bookings/:id/update { waived: true | false }` with a sign-up's id (staff, Money): nothing is due and it isn't owed;
what was paid stays paid.

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `locked` | It's less than 24 hours away, so it can't be cancelled online now: it stays on your tab. Have a chat with us at the counter or give us a call, and we'll sort it out. |
| `started` | That one has already started, so it can't be cancelled online. Have a chat with us if something's not right. |
| `keptSeat` | Your seat on {when} is less than 24 hours away, so it stays on your tab. Have a chat with us if you can't make it. |
| `onTab` | It goes on your tab: pay at the counter on the day, or pay for a few at once. Just give your name at the counter (or show your Goblin card from My Lair). |
| `onTabGuest` | Pay at the counter on the day: just give your name. Make a free Dice Goblin account with this email and it goes on your tab in My Lair. |
| `nothingToPay` | Nothing to pay. Just give your name at the counter when you arrive. |
| `cancelBy` | Can't make it? Cancel in My Lair by {until} (24 hours before). After that it stays on your tab, even if you can't come. |
| `cancelByGuest` | Can't make it? Let us know by {until} (24 hours before): reply to this email or give us a call. After that it's yours to pay, even if you can't come. |
| `lockedNow` | It's less than 24 hours away, so it's locked in: it stays on your tab, even if you can't come. Have a chat with us if something comes up. |
| `pickSome` | Tick what they're paying for. |
| `notTheirs` | One of those isn't on their tab any more. Refresh their page and try again. |
| `nothingDue` | Nothing is left to pay on what you ticked. |

(24 is `refundHours`.) Confirmation emails have no code (no "Your code" row, no code in the subject); fees read "$40, on
your tab" (a member) or "$40, pay at the counter on the day" (a guest), then `onTab` / `onTabGuest` / `nothingToPay`, then
`cancelBy` / `cancelByGuest` / `lockedNow` (a free one, or one from before: "Can't make it? Cancel in My Lair, so someone
else can have your spot.").

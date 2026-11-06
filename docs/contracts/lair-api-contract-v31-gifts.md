# Lair API contract v31: experience gifts for Christmas

Round 31, 6 November 2026, from the parties, families and newcomers work. Mo's calls on 1 and 6 November 2026:

1. **Two experience gifts**, sold as products before Christmas, email only like the session gift:
   - **Your first roleplaying game**, $30: "a seat and dice ... they pick any dice of $30 or less as part of it ... so
     effectively it would look like the session is free". Any beginner game (Mo: "call it your first roleplaying game and
     have it be any beginner game"), kids at the kids' table too.
   - **Learn to paint**, $10: a seat at Learn to paint "to use our miniature and brushes and paints"; keeping the
     miniature is $5 more, or $20 for a large one.
2. **"3 years, experience honoured"**: a gift lasts 3 years and still covers its experience if prices go up.
3. The gift card is Shopify's own ($25, $50, $100, $200); the session gift (LAIR-GIFT-N) is retired. Nothing here
   changes either, except that a session gift sold from now on also lasts 3 years.

Mo approved the mockups on 6 November 2026 ("Yes, as drawn"): the gift email, the product pages and the gifts in My
Lair's Wallet. **Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

The code: `src/experience-gifts.js` (the kinds, the words, use-by, codes, the email and "Use it now"), with changes in
`src/lair.js` (orders, passes, check-in, undo), `src/email.js` (a code box's name and bold line), `src/tab.js` and
`src/newplayers.js` (a sign-up's cover, one line each). Tests: `test/round31-gifts.test.js` (16 checks); one check in
`test/lair.test.js` (session gifts) now expects the longer code.

## 1. Sold as products

| SKU | Kind | Pass label | Price |
| --- | --- | --- | --- |
| `LAIR-XP-FIRSTGAME` | `first-game` | Gift: Your first roleplaying game | $30 |
| `LAIR-XP-PAINT` | `paint` | Gift: Learn to paint | $10 |

- Any case. An order line with one of these SKUs (online or at the counter, `orders/paid`) makes **one gift a unit**:
  a pass with `source` `gift`, `kind`, 1 session, `cover` 0 (it covers its experience whatever that costs, 3),
  `price_paid` what the unit cost after the line's discounts, no holder, `note` "A gift from Sam" and `gift_from` "Sam"
  (the buyer's first name, when Shopify or the member on the order says), made once per order, line and unit (a webhook
  sent again makes nothing new).
- A `LAIR-XP-…` SKU the Lair doesn't know makes nothing; it's noted for the health check (`unknownGift`: the SKUs and the
  order), never guessed at.
- `orders/paid`'s answer lists every gift's code in `gifts`, as before.

### 1.1 Use by

Every gift sold from now on, **session gifts too**, has `expires_at` = the end of its sale day 3 years on, Lair time:
sold on 6 November 2026, used by the end of 6 November 2029. Sold on 29 February, used by the end of 1 March three years
on (`giftUseBy`). New Zealand's Fair Trading Act (gift cards and vouchers sold since 16 March 2026) wants at least 3
years and the date shown: the email (2), My Lair (4) and the staff page all show it. Gifts sold before stay as they were.

### 1.2 Codes

A gift is a bearer code worth money, handed on in a card and claimed by whoever types it first, so its code is `DG`, a
word and 4 letters or digits, none that reads as another (no 0, O, 1, I or L): `DG-GRIFFIN-7KQ4`, about 240 million of
them. A booking's `DG-GRIFFIN-12` has about 5 thousand, which 10 tries in 10 minutes a member could work through.
Session gifts get the same codes. Case, spaces and dashes don't matter, as for every code.

## 2. The email: "Your gift is ready" (mockup GiftEmail)

To the order's email (or the member on the order), once, after the gifts are made. One gift: subject and title "Your
gift is ready"; more than one: "Your gifts are ready".

- "Kia ora Sam, thanks for buying a gift from the Lair. Gobgob wrapped it themselves." / "… buying gifts … wrapped them
  themselves." ("friend" with no first name)
- "Pass it on however you like: forward this email, print it, or write the code in a card." / "Pass them on … write each
  code in a card."
- A dashed box for each gift: its name in small capitals ("YOUR FIRST ROLEPLAYING GAME"), the code in big letters, what it
  covers, and in bold "Use by 6 November 2029".
  - Your first roleplaying game: "A seat at any beginner game at the Lair, and a set of dice to keep."
  - Learn to paint: "A seat at Learn to paint, with the Lair's miniature, brushes and paints."
  - A session gift on the same order: "5 SESSIONS AT THE LAIR", "5 table sessions at the Lair, each covering one person's
    table fee."
- The details, How to use it once, then each kind's rows:

| Row | Words |
| --- | --- |
| How to use it | Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under "Got a code?". Or just show it at the counter. |
| Kids 8 to 14 | Kids' games, weekdays 4 to 6pm. Staff look after them until pick-up. |
| Teens and adults | Any game that takes beginners. Under-14s come with a grown-up. |
| The dice | Picked at the counter on the day: any set up to $30. |
| Learn to paint | Next class: Thursday 3 December, 6 to 8pm. 8 seats, so book ahead. (the next date and its places, from the event; none in the next 120 days: "It's the first Thursday of the month: the events page has the next one.") |
| Who can paint | Ages 8 and up. Under-12s come with a grown-up, who watches free. |
| Keep the miniature | $5 more on the night, or $20 for a large one. |

- The button: Your first roleplaying game, "See beginner games" (the TTRPG page); Learn to paint, "See the next class"
  (the events page at that date, `#event=learn-to-paint@2026-12-03`; none: "See what's on"); both kinds, "Open My Lair".
- Then: "If prices go up, the gift still covers the game. If the Lair ever stops running beginner games, it becomes store
  credit for what you paid." (Learn to paint: "… still covers the class … stops running Learn to paint …"; both kinds:
  "If prices go up, each gift still covers what it's for. If the Lair ever stops running one, it becomes store credit for
  what you paid.") Gobgob signs off as every email.
- No email on the order (a counter sale with nobody on it) or Resend refused it: the staff get the codes instead,
  "Gift codes to pass on: #1720", saying why, with the same boxes. An order of session gifts only keeps round 6's
  email, now with "Use by …" in each box.

## 3. At the counter

A gift covers its experience for **one person**, whatever it costs on the day. Nothing already paid is covered.

| Gift | Covers | Never |
| --- | --- | --- |
| Your first roleplaying game | one person's whole TTRPG seat (`gm-seat`): its price, GM's fee and all | a table, a game table at an event, a sign-up |
| Learn to paint | one person's entry on a sign-up at Learn to paint (an event whose id or title says Learn to paint: `learn-to-paint`, or a one-off like `learn-to-paint-christmas`) | a booking, any other event, another painting night |

### 3.1 A seat: `POST /checkin`, `POST /pos/checkin` (unchanged routes)

`pass` a gift's code (or the gift saved on the booking) as for any pass. A first game gift covers the seat's price for one
person (`covered` 1500 on a $15 seat), so the seat is paid and its GM is credited as for any paid seat (round 21's
credit, asked to go now as when a seat is paid at the counter). `notice`: "It's their first roleplaying game gift: they
pick a set of dice to keep too, up to $30." On a seat for more than one, it covers one: "The gift covered one of the 2
people. It's their first …". A session pass still covers only the table part of a seat.

On anything it isn't for, nothing is used and `notice` says why:

- "This gift is for a seat at a roleplaying game, so it wasn't used here."
- "This gift is for a seat at Learn to paint, so it wasn't used here."

Past its use-by: "Pass DG-… expired on 6 November 2029, so it wasn't used." (as any pass).

The answer's `pass` adds `kind` when a gift was used (`{ code, label, used, left, covered, useId, kind }`), so the
counter says "gift" rather than counting sessions. A gift's code scanned on its own (`POST /checkin { code }`) answers
`kind` `pass` as any pass, with `message` "Gift: Your first roleplaying game, ready to use." (or "…, used.", "…,
expired.", "…, cancelled.").

### 3.2 A sign-up: the same routes, `type` `join`

Before this, a pass on a sign-up was always "Passes don't cover event entry, so no pass was used." A **session pass**
still is. A Learn to paint gift on a Learn to paint sign-up covers one person's entry (its amount over the people paying
on it), saved on the sign-up; checked in already, it can still be used, as on a booking. The answer's `pass` is
`{ code, label, used, left, covered, useId, kind }` as for a booking.

A sign-up now has, everywhere it's shown to staff (check-in rows, the floor, the POS): `covered` (what gifts covered),
`due` less it, and `pass` (`{ code, label, left, kind }`, the gift saved or used on it, or null). The counter's line says
"(gift covered $10)". Marking a sign-up paid (the staff page, a monthly account's tab) records what was left after the
gift, as a booking's is after a pass.

### 3.3 Saving one ahead

- `POST /bookings { usePass }` (a member's own, or staff's): a gift that isn't for that booking's kind is refused, 422,
  with 3.1's words. A first game gift on a TTRPG seat is saved and used when they check in.
- `POST /passes/:id/apply { bookingId }` (staff): the same, and a Learn to paint gift may go on a Learn to paint sign-up
  (`bookingId` is the sign-up's id) → `{ join, pass }`. Any other pass on a sign-up is refused as before.

### 3.4 "Use it now": `POST /passes/:id/use { note? }` (staff, Check-in or Money)

A gift used for its experience with **nothing booked**: a kid at the kids' table rung up at the counter, a painter at the
station on another Thursday. One go. → `{ pass, message }`, `pass` as staff see it (3.6); `message`:

- "Used: Your first roleplaying game. Don't charge for their seat today, and let them pick a set of dice up to $30."
- "Used: Learn to paint. Don't charge for their seat today. Keeping the miniature is extra."

| Case | Status | error |
| --- | --- | --- |
| not staff, or no Check-in or Money | 403 | as every staff route |
| no such pass | 404 | That pass could not be found. |
| a session pass | 422 | Only a gift is used with nothing booked. A session pass is used when they check in. |
| used already | 409 | That gift has been used. Undo its use first if that was a mistake. |
| void | 409 | That gift has been cancelled. Ask the main account about it. |
| past its use-by | 409 | That gift expired on 6 November 2029. |

The use keeps who did it and their note (up to 120 characters).

### 3.5 Undo: `POST /passes/uses/:useId/undo` (unchanged route)

A gift's use on a sign-up gives the sign-up back what it covered (`covered`, `paid`); one with nothing booked just goes
back on the gift. The answer's `row` is the sign-up's when it was one. A TTRPG seat that owes again after an undo (a first
game gift paid all of it) and whose GM was already credited for it tells staff "GM credit to check", as unmarking a paid
seat does (round 21).

### 3.6 The staff view of a pass (`GET /passes`, the member card, check-in)

A gift adds `kind`, `name` ("Your first roleplaying game"), `covers` (for staff: "Covers one person's whole seat at a
TTRPG session, GM's fee and all, and a set of dice up to $30 to keep." / "Covers one person's seat at Learn to paint:
the Lair's paints, brushes and a miniature from the shelf. Keeping the miniature is extra.") and `from` (the buyer's first
name, or null). Every pass's `uses` adds `joinId` (a sign-up it covered, or null), `note` (staff's words on a "Use it
now", or ''), and `bookingId` is null when there was no booking. `cover` is 0 on a gift and can't be changed
(`POST /passes/:id/update` ignores it); everything else about a gift is edited as any pass.

## 4. My Lair

- "Got a code?" (`POST /me/codes/redeem`) with a gift's code: as any pass, and `message` "Added to your wallet: Your first
  roleplaying game. Use it by 6 November 2029."
- `GET /me`'s `passes`, for a gift: `kind`, `name`, `from` (the buyer's first name, or null; the buyer's note and order
  stay with staff), `expiresAt`, and for Learn to paint `next`: its next class, `{ occurrenceId, title, start, full }`
  (`full`: its places are taken), or null.

## 5. Storage (made when the Lair starts)

- `passes.kind` (`first-game`, `paint`; null on every other pass) and `passes.gift_from` (the buyer's first name).
- `event_joins.covered` (cents, default 0) and `event_joins.pass_id`.
- `pass_uses.join_id` (the sign-up a use covered; its `booking_id` is then '') and `pass_uses.note`; a use with nothing
  booked has `booking_id` '', `join_id` null and `covered` 0. Index `pass_uses_join`.

# Lair API contract v21-gm-cover: a GM pays for one of their players

Round 21, part 2 (26 Oct 2026). From Mo, 26 Oct 2026: "have the option for the gm to pay for someone else if they wish
from one of their players. Paying the full $10 for Thier time and they don't get store credit for them playing." Then,
where: "Both" (the website and the counter); until when: "Until the player has paid".

After its first review (27 Oct 2026), the charge follows the seat whatever changes it, the player paying for their own
seat ends the GM's offer, and a seat the GM pays for is locked in 24 hours before like any seat. After its second, money
back to a GM is worked out from what they've paid, net of what's been given back (section 1, "Money back to the GM"), and
a new GM leaves an offer that's locked in with the GM who made it. **The lock is Mo's call**
(asked 26 Oct 2026: who pays when the player cancels late or doesn't come?). It's built as the option recommended to
him: the GM still pays, as any seat's player would. The other options were "nobody pays" (the first version) and "the
player pays the full price".

The code is `src/gm-cover.js` (methods of the Lair Durable Object), with changes in `src/lair.js`, `src/tab.js`,
`src/gm-sessions.js`, `src/admin.js` and `src/index.js`. Tests: `test/round21-gm-cover.test.js`. It builds on
`lair-api-contract-v21-gm-credit.md` (GM credit that adds itself).

## 1. What it is

- The **player's seat stays theirs**: their place on the roster, their loyalty stamp when they check in, their seat
  counted as taken. It costs them nothing: its `amount` is $0, and `covered_by` names the GM paying for it (`cover_was`
  keeps what it cost when the GM started: a record only).
- The **GM's charge** is a booking of its own, kind **`gm-cover`**, on the GM's account (`customer_id` = the GM):
  - `amount`: the seat's table part for each person on it: the seat price less the session's GM fee. That's $10 a person
    at today's prices, whatever the GM's fee ($15 seat − $5 fee, $20 − $10, or $10 with no fee).
  - `cover_of`: the seat; `game_id`: the session; `starts_at`/`ends_at`: the seat's; `people`: the seat's; no tables, ever.
  - It's billed like any booking: at the counter on the day, owed once the session's over unpaid, on a monthly bill
    for an account that has one. Paying it is a POS sale line with `_booking: <its code>`, as for any booking.
  - It's never checked in, takes no table or seat, earns no stamp, isn't a visit in the weekly numbers, and doesn't
    count towards the 6-bookings-an-email limit.
- The GM gets **no GM credit** for a seat they pay for (a $0 seat isn't a paying player's: contract v21-gm-credit).
- **Until the player has paid**: the GM can pay for a seat with something to pay and nothing paid on it yet (not paid,
  part paid, on a session pass or waived), on a live session (open or full) that isn't free, whose GM has an account.
  Not the GM's own seat. After the session too: an owed seat becomes the GM's owed charge. And when the player does pay
  for their seat themselves (its own line on an order), the GM's offer ends there (below).
- **Locked in like any seat**: from 24 hours before the session (`refundHours`), the player can't cancel the seat
  online, the GM can't stop paying, and a no-show still costs the GM. Staff can change anything. A GM paying for a seat
  inside the 24 hours is locked in at once.

### The charge follows the seat

The seat is what's true. After anything that changes the seat or its session, and in the 10-minute run, the charge is
put in step with it (`syncCover`):

- **On** while the seat is on (confirmed, here, played, or a no-show) on a live session with a price; **off**
  otherwise (the seat cancelled, the session free, cancelled or not live).
- Its **amount** is the session's table part now for each person on the seat. A charge with money paid on it keeps the
  price it was paid at.
- Its **times** are the seat's.

So:

- The player cancels in time, or staff take the seat off: the charge goes. Money the GM paid on it is a refund due
  (`refund: 'due'`), and staff get an email.
- A **no-show**: the charge stays. The GM pays for it, as a player pays for their own no-show.
- The seat is **put back**: the charge comes back, with what the GM has paid on it counting. If it was a refund due and
  not refunded yet, it isn't one now (the money stays paid), and staff get a "No refund now" email. If the GM's money
  went back to them already, they owe it again.
- Staff change the seat's **people**: the seat stays $0 and the charge follows. More people on a paid charge is more for
  the GM to pay (on their tab); fewer is money due back to them (a refund due: staff get an email).
- The session's **price** changes (its GM fee or table price): seats the GM pays for stay $0, and an unpaid charge
  follows the table part.
- The session is made **free**: the charges go while it is, but the GM's offer stays (a paid charge stops it going
  free, like a paid seat: `paidAlready`). Back to a price more than 24 hours before: the charges come back. Inside the
  24 hours: like any seat booked while it was free, it stays free: the offer ends and nobody pays.
- The session is **cancelled**: the charges go with it, and what the GM has paid on each (net of anything given back,
  as below) is due back to them, in the staff's "Refunds due" email with the players' ("$X to give back", or "$X to
  give back in all (it was $Y)" for one that was due already).
- The session is **re-timed or moved**: the charge's times move with it, and it never takes a table.
- The 10-minute run does the same for every seat a GM pays for, in case something changed a seat without saying so
  (`covers: { synced }` in its record when it changed any).

### The GM's offer ends

The seat costs its players a seat's price on the session now (not what it cost before), and the charge goes (money on
it is a refund due, and staff hear why). This happens when:

- **The player pays** for their seat themselves (its own line on an order, at the counter or online): "until the player
  has paid". Their payment counts towards the seat's price as usual, and the GM gets their GM credit for that seat
  like any paid seat. So a cart with both the player's seat line and the GM's line can't take $25 for a $15 seat: the
  GM's $10 is a refund due.
- **The GM or staff stop it** (`uncover`, below).
- **The session gets another GM** (`POST /games/:id/gm`) more than 24 hours before: the old GM's offers end. Each seat
  gets the session's seat price, its player is emailed, and anything the old GM had paid on it is a refund due. From 24
  hours before (or once it's started, or over), an offer is locked in like any seat, so it **stays with the GM who made
  it**: they still pay, and staff get one email ("Still paying: <session>") listing those, to stop any that shouldn't
  stay (sent by the change that leaves an offer with them, not again by a later change that doesn't). The board says who
  pays (`coverBy`), and only staff can stop it. On a free session there's nothing to pay, so the old GM's offers just
  end (the seats stay free, and nobody's emailed). "Locked in" is the seat's own lock, the one the player is held to; a
  seat that's been taken off goes by the 24 hours, so if it's put back later, the GM who made the offer still pays. The
  player's email gives their own cancel-by (for a weekly regular's seat Gobgob saved inside the 24 hours, the start).

### Money back to the GM

What's due back on a charge is **what the GM has paid on it, net of what's been given back, over what it costs now**
(all of it once the charge has gone). That's the only rule, whatever changed:

- The charge's `refund` is `'due'` while that's over $0, with `refundAmount` (stored as `refund_amount`) what to give
  back, and back to none when it isn't.
- Staff hear each time it starts ("Refund due", with why and how much), changes ("Refund due": what to give back is
  $X now, not $Y, in all) or stops ("No refund now": don't refund it). A staff change to the charge that doesn't change
  what's due back (marking it paid again, say) tells them nothing.
- Money paid on a charge that's gone, at the counter or marked by hand, is always counted: a second payment raises what's
  due back, and staff hear the new total. Within one order, staff hear once, after it, whatever the order of its lines.
- Staff **marking it refunded** records the money going back: a payment of minus what was due back (`payments` row with
  `order_id 'refund'`, not shown in the payments staff see), so what the GM has paid is net of it from then on. The
  charge then says `refund: 'done'`, `refundAmount` what went back. `refunded: false` undoes the last one. Nothing due
  back: 409 `There's nothing to give back on that one: what the GM has paid isn't more than it costs.`
- So a part refund counts. Say Rangi pays $30 for 3 people, the seat goes to 1 ($20 due back), staff give it back and
  mark it: he's paid $10 net. If Mia then cancels, $10 is due back. If her seat is put back, nothing's due and he isn't
  charged again. If it goes back up to 3, he owes $20 more.

## 2. Routes

### `POST /games/:id/players/:ref/cover` (website) and `POST /pos/cover { gameId, ref }` (the counter)

`ref`: the seat's code or id. Who: the session's own GM (logged in), or staff with GM games, Check-in or Money (the
staff page), or the POS. → `{ seat, cover, game }`:

- `seat`: the session's roster item for the seat (as `game.roster`), with `covered: true` and `coverLocked`.
- `cover`: `{ ref, amount, people, paid, due, status, locked }`. `locked`: inside the 24 hours.
- `game`: the session as the board shows it to whoever asked.

Refusals, word for word:

| Status | When | Message |
| --- | --- | --- |
| 401 | logged out | `Log in to pay for a player.` |
| 403 | not the session's GM or staff (another GM, the player, a helper without those) | `Only this session's GM or staff can do that.` |
| 404 | no such session | `Game not found.` |
| 404 | not a seat on this session, or not one that's on (cancelled, a no-show, a checkout still open) | `That seat isn't on this session any more.` |
| 409 | the session is cancelled | `This session was cancelled.` |
| 409 | the session isn't live yet | `This session isn't live yet.` |
| 409 | the session is free | `This session is free, so there's nothing to pay for.` |
| 409 | the session's GM has no account | `The GM needs a Dice Goblin account to pay for a player.` |
| 409 | the GM's own seat | `That's your own seat.` |
| 409 | paid, part paid, or a pass covered some | `Mia has paid for their seat already, so there's nothing to pay for.` |
| 409 | waived, or $0 | `Mia has nothing to pay for their seat.` |
| 409 | the GM pays for it already | `The GM is paying for Mia already.` |

(Mia: the seat's first name.)

### `POST /games/:id/players/:ref/uncover` (website) and `POST /pos/uncover { gameId, ref }` (the counter)

The GM stops paying for the seat: it costs a seat's price on the session now (nothing if the session is free), and the
charge goes. Who: the GM paying, **until it's locked in** (24 hours before) and while they haven't paid it; staff (and
the POS) any time, even once the GM has paid (that money is a refund due, and staff get an email), and for a seat that's
been taken off or was a no-show too (to put things right). → `{ seat, cover: null, game }`.

| Status | When | Message |
| --- | --- | --- |
| 409 | the GM isn't paying for that seat | `The GM isn't paying for that seat.` |
| 409 | the GM, once they've paid it | `The GM has paid for that seat already, so it can't change now. Ask staff if it needs a refund.` |
| 403 | the GM, inside the 24 hours | `It's less than 24 hours away, so it's locked in: you pay for this seat, the same as any seat. Ask staff if something's come up.` |

The other refusals are as for cover (401, 403, 404).

### `POST /bookings/:id/update`

- **On a charge**: not for cancelling it or changing its people, by the GM or staff: 409 `To stop paying for them, tap
  "Stop paying" on the session.` Not for moving it (`tables`, `end`): 409 `A GM's charge goes where the player's seat
  goes, so move the session or the seat instead.` Staff can mark it paid or unpaid, waive it, or mark it refunded (money
  back, above). Marking a charge that's gone paid (a page left open, say): 409 `That charge isn't on any more (the GM
  stopped paying, or the seat went), so there's nothing to pay for it.`
- **On a seat its GM pays for**, marking it paid by hand: 409 `The GM pays for this seat, so there's nothing for the
  player to pay. If they're paying for it themselves, stop the GM paying first.`
- **The player cancelling a seat their GM pays for, inside the 24 hours**: 409 `It's less than 24 hours away, so it
  can't be cancelled online now: your GM is paying for your seat. Have a chat with us at the counter or give us a call,
  and we'll sort it out.`

### `POST /games/:id/gm` (staff with GM games)

As before (contract v18). The old GM's offers end or stay as above. A player whose seat gets a price again is emailed
"Your seat has a price now": `Heads up: Curse of Strahd on <when> has a new GM, so Rangi isn't paying for your seat any
more. It's $15.00 on your tab. Can't make it? Cancel it in My Lair by <time>.`

### Other refusals and limits

- `cover` by a GM on a monthly account: within their limit, as a booking is (`That would take your Lair account over its
  $5 limit ($5 left). Pay your bill online or at the counter, then pay for them again.`). Staff at the counter aren't
  limited, as for bookings.
- `uncover` by a GM: only their own offer (403 `Only this session's GM or staff can do that.` for an offer a GM before
  made).

## 3. What clients see

- **The board** (`GET /floor`): `game.players` (the session's GM and staff) and `game.roster` (whoever runs it) gain
  `covered` (the GM pays for this seat), `coverLocked` (on a covered seat: it's locked in now), `coverBy` (on a covered
  seat whose payer isn't the session's GM: their first name) and `coverable` (they could: a seat on, with something to
  pay and nothing paid on it yet, not the GM's own, on a live session with a price and a GM account). While a session is
  free, its seats show neither `covered` nor `coverable` (the offer waits, for if it has a price again).
- **Staff booking views** (`GET /floor` for staff, check-in) gain `refundAmount`: what to give back. For a GM's charge,
  worked out as above; for anything else with a refund due or to decide, what was paid (a part-paid split bill's share,
  not the full price). The charge itself isn't in the public board's `bookings` (nor the GM's): only staff see it there,
  kind `gm-cover`.
- **The staff floor's `gmCredit`** (round 21 sessions) gains `covered: { players }`: seats the GM pays for, which give
  no GM credit.
- **My Lair** (`GET /me`):
  - a player's `seats[]` item gains `coveredByGm: true` when their GM pays for it, on a session with a price (its `due`
    is 0). Its `cancelUntil`/`locked` are a seat's: locked in 24 hours before.
  - a GM gets `covers`: their charges that are on, and any with money due back to them: `[{ id, ref, gameId, title,
    player, start, end, people, amount, due, paid, owed, status, locked, refund?, refundAmount? }]`. `title` is `Paying
    for Mia's seat: Curse of Strahd`; `player` is the first name; `due` is what's left to pay (part paid: less than
    `amount`); `locked`: inside the 24 hours. With money due back, `refund: 'due'` and `refundAmount`: on one that went
    (`status: 'cancelled'`, `due: 0`), or on one that's on but paid over what it costs now. Once staff mark it refunded,
    one that went is gone from the list.
  - their running tab (`account`) lists a charge like any booking, with `kind: 'cover'`: coming up, then owed if it's
    over unpaid. A player's seat their GM pays for has `coveredByGm: true` there too (while the session has a price).
- **The counter**:
  - the GM's member code (`/pos/scan`, `/pos/checkin-member`): today's charge is one of their rows (`kind: 'gm-cover'`,
    never checked in), with its cart line `Paying for Mia's seat: Curse of Strahd (RA-OWL-12)`; an owed one is
    `Owed: Paying for Mia's seat: Curse of Strahd (Tue 27 Oct)`.
  - checking in the charge itself (`/pos/checkin`, `POST /checkin`, its own code): not checked in, `reason: 'cover'`,
    message `Paying for Mia's seat: Curse of Strahd: nothing to check in. Charge $10.00.`, and (`/pos/checkin`) its
    cart line in `lines` while it's on and unpaid. One that's gone has `due: 0` (money on it is due back instead). **For the POS app:** with `reason: 'cover'`, add `lines` to the cart as
    for a check-in (nobody was checked in, but there's something to pay), and don't offer "Check in anyway".
  - the POS Today list doesn't list charges (they aren't people arriving).
  - the player's seat checks in as usual, with nothing to pay.

## 4. Staff emails

| Subject | When |
| --- | --- |
| `Refund due: <charge code>` | money due back to a GM starts (the seat taken off, the player paid for it too, staff stopped it, another GM before the 24 hours, fewer people, paid after it had gone) or changes (more paid, or less due). It says why, what they've paid, and what to give back in all. |
| `No refund now: <charge code>` | money that was due back isn't now (the seat put back, more people): don't refund it. |
| `Still paying: <session>` | a session got a new GM inside the 24 hours (or after it started), so the GM before still pays for the seats listed. |
| `Refunds due: <session>` | the session was cancelled (as before), with the GM's paid charges listed with the players'. |
| `Paid for a free seat: <code>` | a seat that costs nothing (the session is free) was paid for, from a counter line made before: refund it. |

## 5. Data

`bookings` gains `covered_by` (TEXT), `cover_was` (INTEGER), `cover_of` (TEXT) and `refund_amount` (INTEGER: a
charge's money to give back, or given back), with an index on `cover_of`. Rows of kind `gm-cover` are new; every place
that counts seats, stamps, visits or rosters reads kinds by name, so they're left out without a change. A seat's charge
is its latest `gm-cover` row (a seat the GM stopped paying for and paid for again has an earlier one, as history). Money
given back to a GM is a `payments` row with `order_id 'refund'` and a negative amount.

Also, from GM credit (contract v21-gm-credit): Session done on a session whose GM pays for every player's seat says
`The GM pays for their players' seats on this session, so there's no GM credit to add.`

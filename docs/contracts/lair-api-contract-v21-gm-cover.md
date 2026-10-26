# Lair API contract v21-gm-cover: a GM pays for one of their players

Round 21, part 2 (26 Oct 2026). From Mo, 26 Oct 2026: "have the option for the gm to pay for someone else if they wish
from one of their players. Paying the full $10 for Thier time and they don't get store credit for them playing." Then,
where: "Both" (the website and the counter); until when: "Until the player has paid".

After its review (27 Oct 2026), the charge follows the seat whatever changes it, the player paying for their own seat
ends the GM's offer, and a seat the GM pays for is locked in 24 hours before like any seat. **The lock is Mo's call**
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
- The seat is **put back**: the charge comes back. If it was a refund due and not refunded yet, it isn't one now (the
  money stays paid), and staff get a "No refund now" email. If the GM's money went back to them already, a new charge
  starts, for them to pay again.
- Staff change the seat's **people**: the seat stays $0 and the charge follows. More people on a paid charge is more for
  the GM to pay (on their tab); fewer is money to give back: staff get an "Overpaid" email, and it's noted on the charge.
- The session's **price** changes (its GM fee or table price): seats the GM pays for stay $0, and an unpaid charge
  follows the table part.
- The session is made **free**: the charges go while it is, but the GM's offer stays (a paid charge stops it going
  free, like a paid seat: `paidAlready`). Back to a price more than 24 hours before: the charges come back. Inside the
  24 hours: like any seat booked while it was free, it stays free: the offer ends and nobody pays.
- The session is **cancelled**: the charges go with it, and one the GM had paid is a refund due, in the staff's
  "Refunds due" email with the players'.
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
- **The session gets another GM** (`POST /games/:id/gm`): the old GM's offers end. A seat that can still be cancelled
  online (more than 24 hours before) gets the session's seat price, and its player is emailed. Inside the 24 hours it
  stays free (they can't cancel it now, and didn't choose a price). A charge the old GM has paid stops the change
  (409, below): staff stop it first, which flags the refund.

A GM paying a charge after their offer ended (the player paid first, say) gets a refund due, and staff get an email.

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
charge goes. Who: the session's GM **until it's locked in** (24 hours before) and while they haven't paid it; staff (and
the POS) any time, even once the GM has paid: that money is a refund due, and staff get an email. → `{ seat, cover:
null, game }`.

| Status | When | Message |
| --- | --- | --- |
| 409 | the GM isn't paying for that seat | `The GM isn't paying for that seat.` |
| 409 | the GM, once they've paid it | `The GM has paid for that seat already, so it can't change now. Ask staff if it needs a refund.` |
| 403 | the GM, inside the 24 hours | `It's less than 24 hours away, so it's locked in: you pay for this seat, the same as any seat. Ask staff if something's come up.` |

The other refusals are as for cover (401, 403, 404).

### `POST /bookings/:id/update`

- **On a charge**: not for cancelling it or changing its people, by the GM or staff: 409 `To stop paying for them, tap
  "Stop paying" on the session.` Staff can still mark it paid or unpaid, waive it, or mark it refunded, as any booking.
- **The player cancelling a seat their GM pays for, inside the 24 hours**: 409 `It's less than 24 hours away, so it
  can't be cancelled online now: your GM is paying for your seat. Have a chat with us at the counter or give us a call,
  and we'll sort it out.`

### `POST /games/:id/gm` (staff with GM games)

As before (contract v18), plus: when the session's GM has paid a player's seat on it (or any session the change moves),
409 `Rangi has paid for a player's seat on this session already. Tap "Stop the GM paying" on that seat first (it flags
Rangi's refund), then change the GM.` Nothing changes. After a change, the old GM's offers end (above). A player whose
seat gets a price again is emailed "Your seat has a price now": `Heads up: Curse of Strahd on <when> has a new GM, so
Rangi isn't paying for your seat any more. It's $15.00 on your tab. Can't make it? Cancel it in My Lair by <time>.`

## 3. What clients see

- **The board** (`GET /floor`): `game.players` (the session's GM and staff) and `game.roster` (whoever runs it) gain
  `covered` (the GM pays for this seat), `coverLocked` (on a covered seat: it's locked in now) and `coverable` (they
  could: a seat on, with something to pay and nothing paid on it yet, not the GM's own, on a live session with a price
  and a GM account). The charge itself isn't in the public board's `bookings` (nor the GM's): only staff see it there,
  kind `gm-cover`.
- **The staff floor's `gmCredit`** (round 21 sessions) gains `covered: { players }`: seats the GM pays for, which give
  no GM credit.
- **My Lair** (`GET /me`):
  - a player's `seats[]` item gains `coveredByGm: true` when their GM pays for it (its `due` is 0). Its
    `cancelUntil`/`locked` are a seat's: locked in 24 hours before.
  - a GM gets `covers`: their charges that are on, and any that went with money they'd paid on it, still to come back
    to them: `[{ id, ref, gameId, title, player, start, end, people, amount, due, paid, owed, status, locked, refund?,
    refundAmount? }]`. `title` is `Paying for Mia's seat: Curse of Strahd`; `player` is the first name; `locked`: inside
    the 24 hours. One that went has `status: 'cancelled'`, `refund: 'due'`, `refundAmount` (what comes back) and `due:
    0`; once staff mark it refunded it's gone from the list.
  - their running tab (`account`) lists a charge like any booking, with `kind: 'cover'`: coming up, then owed if it's
    over unpaid. A player's seat their GM pays for has `coveredByGm: true` there too.
- **The counter**:
  - the GM's member code (`/pos/scan`, `/pos/checkin-member`): today's charge is one of their rows (`kind: 'gm-cover'`,
    never checked in), with its cart line `Paying for Mia's seat: Curse of Strahd (RA-OWL-12)`; an owed one is
    `Owed: Paying for Mia's seat: Curse of Strahd (Tue 27 Oct)`.
  - checking in the charge itself (`/pos/checkin`, `POST /checkin`, its own code): not checked in, `reason: 'cover'`,
    message `Paying for Mia's seat: Curse of Strahd: nothing to check in. Charge $10.00.`, and (`/pos/checkin`) its
    cart line in `lines` while it's on and unpaid.
  - the POS Today list doesn't list charges (they aren't people arriving).
  - the player's seat checks in as usual, with nothing to pay.

## 4. Staff emails

| Subject | When |
| --- | --- |
| `Refund due: <charge code>` | money the GM paid on a charge that went: the seat taken off, the player paid for it too, staff stopped it, or the GM paid after it had gone. The email says which, and how much. |
| `No refund now: <charge code>` | a seat put back while its charge was a refund due: the GM's money stays paid. |
| `Overpaid: <charge code>` | fewer people on a seat whose charge was paid: the difference to give back. |
| `Refunds due: <session>` | the session was cancelled (as before), with the GM's paid charges listed with the players'. |

## 5. Data

`bookings` gains `covered_by` (TEXT), `cover_was` (INTEGER) and `cover_of` (TEXT), with an index on `cover_of`. Rows
of kind `gm-cover` are new; every place that counts seats, stamps, visits or rosters reads kinds by name, so they're
left out without a change. A seat's charge is its latest `gm-cover` row; earlier ones (stopped, or refunded and
started again) stay as history.

# Lair API contract v21-gm-cover: a GM pays for one of their players

Round 21, part 2 (26 Oct 2026). From Mo, 26 Oct 2026: "have the option for the gm to pay for someone else if they wish
from one of their players. Paying the full $10 for Thier time and they don't get store credit for them playing." Then,
where: "Both" (the website and the counter); until when: "Until the player has paid".

The code is `src/gm-cover.js` (methods of the Lair Durable Object), with changes in `src/lair.js`, `src/tab.js`,
`src/gm-sessions.js`, `src/admin.js` and `src/index.js`. Tests: `test/round21-gm-cover.test.js`. It builds on
`lair-api-contract-v21-gm-credit.md` (GM credit that adds itself).

## 1. What it is

- The **player's seat stays theirs**: their place on the roster, their loyalty stamp when they check in, their seat
  counted as taken. It costs them nothing: its `amount` is $0, `covered_by` names the GM paying for it, and `cover_was`
  keeps what it cost (for when the GM stops).
- The **GM's charge** is a booking of its own, kind **`gm-cover`**, on the GM's account (`customer_id` = the GM):
  - `amount`: the seat's table part for each person on it: the seat price less the session's GM fee. That's $10 a person
    at today's prices, whatever the GM's fee ($15 seat − $5 fee, $20 − $10, or $10 with no fee).
  - `cover_of`: the seat; `game_id`: the session; `starts_at`/`ends_at`: the session's; `people`: the seat's; no tables.
  - It's billed like any booking: at the counter on the day, owed once the session's over unpaid, on a monthly bill
    for an account that has one. Paying it is a POS sale line with `_booking: <its code>`, as for any booking.
  - It's never checked in, takes no table or seat, earns no stamp and isn't a visit in the weekly numbers.
- The GM gets **no GM credit** for a seat they pay for (a $0 seat isn't a paying player's: contract v21-gm-credit).
- **Until the player has paid**: only a seat with something to pay and nothing paid on it yet (not paid, part paid, on a
  session pass or waived), on a live session (open or full) that isn't free, whose GM has an account. Not the GM's own
  seat. After the session too: an owed seat becomes the GM's owed charge.

### The charge follows the seat

- The player cancels, is taken off the game, or is marked a no-show: the charge is cancelled. **A GM only pays for
  players who play.** A charge the GM had paid is a refund due (`refund: 'due'`), and staff get an email.
- The seat is put back (staff undo a cancellation or no-show): the charge comes back, unless it had been paid.
- Staff change the seat's people: the seat stays $0, and the charge (and `cover_was`) follow, while it's unpaid.
- The session is made free: the charges are cancelled and the seats are simply free (a paid charge stops it going
  free, like a paid seat: `paidAlready`). Back to a price: the seats are priced for their players again.
- The session is cancelled: the charges go with it, and one the GM had paid is a refund due, in the staff's
  "Refunds due" email with the players'.
- A seat price change for the session leaves a covered seat at $0.
- The 10-minute run puts any charge back in step with its seat, in case something changed a seat without saying so
  (`covers: { synced }` in its record).

## 2. Routes

### `POST /games/:id/players/:ref/cover` (website) and `POST /pos/cover { gameId, ref }` (the counter)

`ref`: the seat's code or id. Who: the session's own GM (logged in), or staff with GM games, Check-in or Money (the
staff page), or the POS. → `{ seat, cover, game }`:

- `seat`: the session's roster item for the seat (as `game.roster`), with `covered: true`.
- `cover`: `{ ref, amount, people, paid, due, status }`.
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

The GM stops paying for the seat: it costs what it did before (nothing if the session is free now) and the charge is
cancelled. Who: the session's GM **until the session starts**, staff (and the POS) any time. Only while the charge isn't
paid. → `{ seat, cover: null, game }`.

| Status | When | Message |
| --- | --- | --- |
| 409 | the GM isn't paying for that seat | `The GM isn't paying for that seat.` |
| 403 | the GM, once the session has started | `The session has started, so ask staff to change it.` |
| 409 | the charge is paid | `The GM has paid for that seat already, so it can't change now. Ask staff if it needs a refund.` |

(A charge that went with its seat, was paid and is a refund due, no longer blocks this: staff can put the seat's price
back.) The other refusals are as for cover (401, 403, 404).

### `POST /bookings/:id/update` on a charge

Not for cancelling it or changing its people, by the GM or staff: 409 `To stop paying for them, tap "Stop paying" on the
session.` Staff can still mark it paid or unpaid, waive it, or mark it refunded, as any booking.

## 3. What clients see

- **The board** (`GET /floor`): `game.players` (the session's GM and staff) and `game.roster` (whoever runs it) gain
  `covered` (the GM pays for this seat) and `coverable` (they could: a seat on, with something to pay and nothing paid
  on it yet, not the GM's own, on a live session with a price and a GM account). The charge itself isn't in the
  public board's `bookings` (nor the GM's): only staff see it there, kind `gm-cover`.
- **The staff floor's `gmCredit`** (round 21 sessions) gains `covered: { players }`: seats the GM pays for, which give
  no GM credit.
- **My Lair** (`GET /me`):
  - a player's `seats[]` item gains `coveredByGm: true` when their GM pays for it (its `due` is 0).
  - a GM gets `covers`: their charges that aren't cancelled, `[{ id, ref, gameId, title, player, start, end, people,
    amount, due, paid, owed, status }]`. `title` is `Paying for Mia's seat: Curse of Strahd`; `player` is the first name.
  - their running tab (`account`) lists a charge like any booking, with `kind: 'cover'`: coming up, then owed if it's
    over unpaid.
- **The counter**:
  - the GM's member code (`/pos/scan`, `/pos/checkin-member`): today's charge is one of their rows (`kind: 'gm-cover'`,
    never checked in), with its cart line `Paying for Mia's seat: Curse of Strahd (RA-OWL-12)`; an owed one is
    `Owed: Paying for Mia's seat: Curse of Strahd (Tue 27 Oct)`.
  - checking in the charge itself (`/pos/checkin`, `POST /checkin`): not checked in, `reason: 'cover'`, message
    `Paying for Mia's seat: Curse of Strahd: nothing to check in. Charge $10.00.`
  - the POS Today list doesn't list charges (they aren't people arriving).
  - the player's seat checks in as usual, with nothing to pay.

## 4. Data

`bookings` gains `covered_by` (TEXT), `cover_was` (INTEGER) and `cover_of` (TEXT), with an index on `cover_of`. Rows
of kind `gm-cover` are new; every place that counts seats, stamps, visits or rosters reads kinds by name, so they're
left out without a change.

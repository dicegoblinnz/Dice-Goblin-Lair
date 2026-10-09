# Lair app API: round 11, Warhammer game tables (9 Oct 2026)

**Changes only**, on top of `lair-api-contract-v9-*.md`, `lair-api-contract-v8.md` and everything before them. Money in
cents, times in ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or
5xx.

Builder: warhammer (backend `r11-w-api`, theme `r11-w`). Mo (9 Oct 2026, 7pm): "Warhammer, Thursdays from 6pm till
midnight. Book tables from T8-T21(with T16-T17 is the painting station) for Warhammer with games needing to be organized
for one on one or two on two games, and people inside the Warhammer group can book their spots with the code of Thier
opponent or their email to help them join us. They can choose a specific table as well but it needs to be two at a time
so they choose the following, T8-t9, t10-t11, t12-t13, t20-t21. Etc.etc. set the fee to $10 per person."

The event itself is data (the coordinator makes it): "Warhammer night", Thursdays 6pm to midnight, weekly, tables
`T8-T21` locked, game tables `T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21` (T16-T17 is the painting station:
inside the hold, never a game table), entry fee $10, paid in store. Nothing here is Warhammer-only: any event with game
tables works the same way.

Code: `src/warhammer.js` (methods mixed into the Lair, like `src/interest.js`), hooks in `src/lair.js`, tests in
`test/round11-warhammer.test.js`.

---

## 1. Reserving a game table

### `POST /events/:occurrenceId/reserve` (anyone; as v4, plus three fields)
Body: `{ name, email, phone, people, pay?, usePass?, notes?, spot?, players? }`.

- **`spot`** (new): the pair picked, like `"T8+T9"` (any case; `+`, `,` or spaces between: `"t9 + t8"` is the same pair).
  Left out: the first free pair, as before.
- **`people`**: `2` (1 v 1) or `4` (2 v 2). An older page's `1` (and `2` with no players) still works as before. A pair of
  tables seats 8, so 4 always fits. Anything else is refused.
- **`players`** (new): the other players, in this order: 1 v 1, `[opponent]`; 2 v 2, `[teammate, opponent, opponent]`.
  Each is `{ code }` or `{ email }` (or a plain string; a value with `@` in it is read as an email, anything else as a
  member code):
  - a **code** must be a member's (any case, dashes optional, as check-in reads codes);
  - an **email** that belongs to a member (their profile email or their verified Shopify account email, ignoring case)
    links to that member; any other email is someone to **invite**.
  - Left out: no named players (an older page), except for 2 v 2, which needs them.
- **The price** is the event's entry fee a person (else the table's price), × `people`, as before. With players named,
  the booking is a **split bill** (`split: true`): each player pays their own share at the counter.
- **Order of checks** (the first that fails answers): event found (404), not finished, has game tables, `people`, name,
  email, mobile, the rate limit, the per-email limit, `spot`, `players`, then whether the pair is still free.

**Answer** (200), as before plus the players on the booking: `{ booking, spotsLeft, notice?, emailed?, checkoutUrl?,
holdMinutes? }`, where `booking` (the booker's own view) adds, when it has players:
- `gameSize`: `'1 v 1'` or `'2 v 2'`;
- `gamePlayers`: `[{ name, role: 'teammate' | 'opponent', member, invited, email }]` in order. `name` is the member's name
  as the Lair has it, or `"Invited player"` for an invite. The booker sees the emails (the ones they typed, or the
  member's). Codes are never in it.

**Messages, word for word:**
| Status | When | Message |
|---|---|---|
| 422 | `people` isn't 1, 2 or 4 (or players are sent with 1) | `A game table is for 1 v 1 (2 players) or 2 v 2 (4 players).` |
| 422 | `spot` isn't one of the date's pairs (`T16 + T17`, the painting station, say) | `T16 + T17 isn't one of this date's game tables. Pick a pair from the list.` (the pair as typed, in capitals, joined by " + ") |
| 409 | `spot` is taken by now | `T8 + T9 has just been reserved. Pick another pair of tables.` |
| 409 | every pair is taken (as before) | `All the game tables are taken for this one. Try another date.` |
| 422 | 1 v 1 with `players: []` | `Add your opponent: their member code or email.` |
| 422 | 2 v 2 with players left out or not 3 of them | `Add the other 3 players: a member code or an email each.` |
| 422 | an empty entry | `Add a member code or an email for each player.` |
| 422 | an email that isn't one | `jo@example doesn't look like an email address. Check it, or use their member code.` (as typed) |
| 422 | a code nobody has | `Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or use their email instead.` (as typed, in capitals) |
| 422 | the booker's own code (logged in, or a member whose email is the booking's) | `That's your own member code. Add the people you're playing with.` |
| 422 | the booker's own email (the booking's, their profile's or account's, or a member that's them) | `That's your own email. Add the people you're playing with.` |
| 422 | the same person twice (by code and email, or the same email) | `Kiri Smith is on the list twice.` (their name, or the email as typed) |

### Emails
- **The booker's confirmation** ("Your game spot is booked!", as before) adds `Game: 2 v 2` and `Playing: You and Tama
  Rewiti against Kiri Smith and jo@example.com`; the fee reads `$10 a person, paid at the counter. Each player pays their
  own.` and the line under it `Each player pays their own $10 at the counter. The others give their member code (or this
  booking's code) when they arrive.`
- **Every other player with an email** gets one email (once: `invited_at`), when the booking is confirmed (straight away
  at the counter; once paid, for one paid online):
  - Subject: `Warhammer night with Sam: Thursday, 15 October at 6:00 pm to 12:00 am (SJ-OWLBEAR-17)`
  - Title: `You've got a game!`
  - Intro: `Kia ora Kiri, Sam Jones has booked a 2 v 2 game with you at Warhammer night, at the Dice Goblin Lair. Gobgob
    has saved your tables.` (a teammate also reads `You're on Sam's team.`; someone invited reads `Kia ora there, …`)
  - Details: Event, When, Where (`Tables T12 + T13`), Game, Playing (from their side: `Sam Jones and Tama Rewiti against
    you and an invited player`; never another player's email), Fee (`$10 a person, paid at the counter`), Booking code.
  - A member: `Give your member code at the counter when you arrive: it finds the game. Your code is in My Lair, and so
    is this game.` Button: `See it in My Lair`.
  - Someone invited: `Make your free Dice Goblin account with this email (jo@example.com) and the game shows up in My
    Lair. Until then, give the booking code above at the counter.` Button: `Make your free account` (My Lair).
  - Both: `Can't make it? Let Sam know, so they can find someone else.`
- Signed off as every booking email (Gobgob's layout, the shop's footer).

### `GET /floor` adds `gameSpots` (everyone)
`{ [occurrenceId]: [{ id: 'T8+T9', label: 'T8 + T9', tables: ['T8', 'T9'], free }] }` for every date with game tables,
in the event's order. `free` is whether that pair is free for the date's whole time (the event's own hold doesn't count
against it; any booking, game or staff hold on either table does). `eventSpots` stays exactly as it was.

---

## 2. My Lair (`GET /me`)
- **The booker's** `bookings` entries add `gameSize` and `gamePlayers` (as the reserve answer: with emails).
- **A named member** (by code, by an email that's theirs, or once they make their account with the invited email) gets
  the game in their `bookings` too, in start order among their own:
  `{ id, ref, kind: 'table', tables, room, start, end, people, status, occurrenceId, extras, title (the event's), playerOf:
  { name } (the booker's first name), canCancel: false, role ('teammate' | 'opponent'), gameSize, ticketCode (their own
  member code: check-in finds the game by it), gamePlayers, amount, due, paidAmount, paid, pay: 'day', payment: 'store',
  split: false, pass: null, covered: 0, refund: null, owed: false, waived }`.
  - `gamePlayers` here is names only, the booker first (`role: 'booker'`), with `you: true` on their own entry. No emails,
    no codes.
  - **Money is their own share**: `amount` is the price a person; `paidAmount` what orders with them as the customer paid
    toward the booking; `due` = that share less what they paid, never more than is left on the booking, and 0 once the
    booking is paid, waived, cancelled or a no-show.
  - A cancelled game stays listed with its status (so they know it's off), as the booker's does.
- **`dueNow`** (what they can pay at the counter today) includes their own share of today's games:
  `{ title: 'Game table at Warhammer night', due: 1000, … }`.
- **Adoption** (`adoptGuestBookings`, round 6): a named player's row with no account whose email is the member's verified
  account email (ignoring case), for a game upcoming or ended in the last 30 days, becomes theirs (their customer id, name
  and code). Never on a game they booked themselves.

## 3. Check-in, the staff page and the POS
- **A named player's member code at the staff page** (`POST /checkin { code }`): the member card lists today's games
  they're a named player in (someone else's booking), as rows that act on the game (`id` is the booking's id, `type:
  'booking'`), with `playerOf: { name }`, `player: { id, role }`, `bookingId`, their own name, `customerId`, and their own
  share as `amount`/`paidAmount`/`due`. Their share is in the card's `due`. The message adds `Sam booked them into a game
  at Warhammer night at 6:00 pm (SJ-OWLBEAR-17, their share $10.00).` Checking the row in checks the game in (everyone on
  it), as round 8's guest rows do.
- **At the POS** (`POST /pos/scan` for a member code): today's rows add the games they're a named player in, as
  `playerRow`s whose `id` is the player's own row id (`bp_…`): `POST /pos/checkin { id: 'bp_…' }` checks the game in and
  answers with their row and one cart line for their share:
  `{ title: 'Game spot share: Warhammer night (SJ-OWLBEAR-17, Kiri Smith)', price: '10.00', quantity: 1, taxable: true,
  properties: { _booking: 'SJ-OWLBEAR-17', _share: '1' } }`, and `customer: { id: <the player> }` (so the order's customer
  is them and the payment counts as theirs). `POST /pos/checkin-member` does the same for each of their games. Paying the
  line adds to the booking's `paidAmount`, as any share does. The booker's own code (or the booking's) still finds the
  whole booking, split as before.
- **Staff views** of a game with players (the staff floor's bookings, check-in rows and answers, the POS's rows and Today
  list) add `gameSize` and `gamePlayers: [{ name, role, member, invited, email, code, customerId }]`.
- No new staff routes, no new permissions.

## 4. Storage (one migration entry, appended)
```sql
CREATE TABLE IF NOT EXISTS booking_players (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, name TEXT, customer_id TEXT,
  email TEXT, code TEXT, invited_at INTEGER, created_at INTEGER NOT NULL)
CREATE INDEX IF NOT EXISTS booking_players_booking ON booking_players (booking_id)
CREATE INDEX IF NOT EXISTS booking_players_customer ON booking_players (customer_id)
CREATE INDEX IF NOT EXISTS booking_players_email ON booking_players (lower(email))
```
One row per named player, in order (`position` 1 to 3). `name` and `code` are what the Lair had for a member when they
were named (views read the member's current name and code); `customer_id` is NULL for an invite until they make their
account. `invited_at`: when their email went out. No cron work.

## 5. Theme (r11-w)
- **The calendar's game table form** (`assets/lair-calendar.js`, "Reserve a game table"): "Pick your tables" (a chip per
  pair from `gameSpots`: taken ones say "taken" and can't be picked; the first free one picked; from an older app, every
  pair of the event, all pickable), "Game size" ("1 v 1 (2 players)", "2 v 2 (4 players)"; 1 v 1 first), "Who's playing"
  (one box each: "Your opponent", or "Your teammate", "Opponent 1", "Opponent 2"; a member code or an email; what's typed
  is kept when the size changes), the fee legend "$10 a person" and the line "$10 a person × 2 players, each paid at the
  counter $20"; the button "Reserve · $10 each at the counter". The form stops an empty box, an email that isn't one, your
  own code or email and the same entry twice (the app's words); the app's refusals go under the right box; a pair just
  taken is marked taken and the next free one picked.
- **The ticket** adds "Game" and "Playing" ("You and Hemi Walker against Tama Rewiti and jo@example.com"), and the fee
  "$10 a person · Each pays at the counter".
- **Your own panel on the event** lists who's playing; a game someone else booked you into is "You're playing in Ruby's
  game" with the tables, the size, who's playing, your Goblin card, your own $10, and "Only Ruby can change this booking."
  (no cancel). The button reads "You're playing: show my code".
- **My Lair**: the booker's ticket adds Game and Playing, and "Each player pays their own $10 at the counter."; a named
  player's ticket: "You're playing in Ruby's game", Event, Tables, Game, Playing, "Your fee $10 · Pay at the counter",
  "Pay your own $10 at the counter when you arrive.", "Only Ruby can change this booking. Plans changed? Let them know,
  or call us.", their Goblin card as the ticket, no cancel or pay.
- **The staff page**: a game's players on the floor's booking card and the check-in card (size, each name with their
  role, members with their code, invites by email); the member card's game rows ("Playing · Kai booked them into this
  game", "Their share: $10 of Kai's game", Check in).
- **The event's fee line** says "$10 a person" (was "a player").
- **Demo** (`assets/lair-demo.js`): all of the above with the same words; an event's own locked tables no longer count
  against its own game spots (as the Lair app's `freeSpots`), so Mo's locked Warhammer night has free pairs in the demo.

## Contract notes
- **Payment:** "each player pays their own $10 at the counter" uses the existing split bill: the booking is `split`, the
  POS sells each named player their share (with them as the order's customer, so it's recorded as theirs), and paying it
  adds to the booking's `paidAmount`. Staff "Mark paid" on the staff page still marks the whole game paid (the group paid
  together). No per-player payment table.
- **Players are required** on the new form (both sizes), matching "games needing to be organized"; the app still takes an
  older page's booking with none.
- **Loyalty stamps** stay as they were: the booker's account gets the game's stamps when it's checked in. Named players
  with accounts don't get their own stamp yet (round 8 did that for event guests); a small follow-up if Mo wants it.
- **Cancelling:** only the booker (or staff) cancels; the named players see it as cancelled in My Lair. Nobody is emailed
  about a cancellation (none is today for game spots either).
- **No new staff route or permission.** The coordinator's own round 11 work (two-day events, GM game import, players
  already in the group, pictures by URL) isn't touched.

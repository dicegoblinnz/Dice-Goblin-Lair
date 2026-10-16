# Lair app API: round 18, more for GM sessions (16 Oct 2026)

**Changes only**, on top of v17-staff-gm-credit and everything before it; where they disagree, this file wins. Money in
cents, times in ms (UTC), days and hours in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }`
with a 4xx or 5xx. Backend: `src/gm-sessions.js` (with small changes in `src/lair.js`, `src/core.js` and
`src/staff-gm.js`). Theme: the GM page (`assets/lair-games.js`, `assets/lair-join.js`), the staff page's GM games tab
(`assets/lair-staff.js`), the events calendar's price (`assets/lair-calendar.js`) and the demo (`assets/lair-demo.js`).

Mo (16 Oct):
- "I want the staff to be able to see each player inside a gm session run game and have the ability to reserve seats
  to newer players. And have the ability to kick players out of they need. Or reserve seats etc. as well." He picked
  two things: **staff GMs, in their own game** (staff running a session can see its players, reserve seats and remove
  players from the GM page) and **seats held for new players** (a session keeps some seats for new players only, so
  regulars can't fill them; staff can release them).
- "Also have staff have the ability to make certain games free for special events or just regular events, that are
  specific gm run games."
- "Have the ability for staff to change the gm for a game even after it was set."

## 1. Rules

### 1.1 Who can do what

- **Run a game** (see its roster, reserve seats, remove players, seats for new players): staff with GM games
  (`sessions`), in any game; and a session's own GM when they're on the team (the main account or a helper, whatever
  their permissions), in their own game. A GM who isn't staff can't (they see their players as before).
- **Free** and **a new GM**: staff with GM games only.
- A staff GM (without GM games) changes seats in their own session only **until it ends** (`403 over`): after that,
  removing or adding a player, or the seats for new players, is for staff with GM games (or the desk on the staff
  page), so nobody clears or makes what's owed for their own session.
- **A series with more than one GM.** Once staff give some of a series to another GM it can have more than one, so the
  GM of one session no longer speaks for all of it. For anyone without GM games: cancelling "every session" cancels the
  sessions they run (and the series itself, no more dates and its regulars, only when it's theirs now: the series' GM,
  which a new GM given it from a session on becomes); adding a date needs the series' GM now, and a new date is always
  the series' GM's (staff adding one too); messaging "every session" reaches the series' players only for its GM now,
  and otherwise the players of the sessions they run; a new picture is the whole series' only from its GM now, and
  otherwise goes on the sessions they run. Series-wide seats for new players from a staff GM change the sessions they
  run.

### 1.2 Seats for new players

- A session can keep some of its seats (`newSeats`, 0 to its seats) for players **new to the Lair's TTRPG sessions**:
  nobody with a seat (theirs by account, or for someone without one by email) at a session that started before, that
  wasn't cancelled or a no-show. Someone with neither an account nor an email isn't known, so isn't new (staff can say
  they are).
- Online (`POST /bookings`, join-series), someone who isn't new can't take a kept seat: when only kept seats are left,
  or fewer than they want are, it's a 409 (words in section 3). A new player can take any seat; their seats fill the
  kept ones first (`bookings.new_player`).
- **Kept seats come first.** The seats held for a series' waiting regulars come from the free seats that aren't kept, so
  a regular who isn't new never waits on a kept seat (and never blocks one). Regulars are seated in the order they
  joined, each in a seat that isn't kept unless they're new as of that session: only a new regular's first seat fills
  a kept one.
- Staff, and the session's staff GM, can seat anyone in a kept seat (`POST /games/:id/players`, with `newPlayer: true`
  for someone new they can't look up), and can let them go (0). A released seat goes to a waiting regular at the next
  maintenance run (every 10 minutes), as a seat that comes free always has.
- For a series, `scope: 'series'` sets it for this session and every later one, and for sessions made later.

### 1.3 Free sessions

- Staff make a session, or (`scope: 'series'`) it and every later one, free: its seats cost nothing (`seatPrice` 0), the
  unpaid seats on it come to $0, nothing is on anyone's tab for it, and there's no GM credit ("Session done" records
  none, saying why).
- Not while a seat on it is paid for already (paid at the counter ahead, marked paid with money, or covered in part by
  a session pass at check-in): 409, sort it out first (a refund, or undo the pass). A seat at $0 (or one marked paid at
  $0) doesn't count. Bills with its seats on them are worked out again (a bill with nothing left on it is void).
- Not free any more: a seat booked while it was free (at $0, nothing paid) gets the session's price back only while it
  can still be cancelled online, more than refundHours (24) before it starts; it's owed then even if it was marked paid
  at $0, and its player is emailed ("Your session has a price now", words in section 3). Inside the 24 hours, or once
  it's started, it stays free: they booked it free and couldn't cancel it now. New seats pay the price.
- A staff edit (a new GM fee, say) keeps a free session's seats at $0 and keeps its price for later.
- GM credit counts only the paying players whose seats cost something: a $0 seat marked paid isn't one. "Session done"
  on a free session records it with no credit (`status 'none'`, the `freeCredit` note) whatever `expect` the button
  sent, and the floor never weighs GM credit for staff (`staffGm`) for a free session.
- GM emails say "None: this session is free for the players, so there are no GM fees" for its credit.

### 1.4 Removing a player

- `POST /games/:id/players/:ref/remove` cancels a seat booking as staff cancel one on the staff page: no email to the
  player, and the GM isn't emailed. What they'd paid for it (at the counter ahead of time, or online) is flagged: before
  the session starts it's a refund due (`refund: 'due'`), and once it's started, or when a session pass covered it,
  staff decide (`refund: 'ask'`, with a `[Refund?]` note); either way the staff are emailed (a pass: undo it on the
  staff page).

### 1.5 A new GM

- Staff give a session, or (`scope: 'series'`) it and every later one, to another GM: a customer picked from the search
  (`gmCustomerId`, with `gmCustomerName` and `gmEmail` for one the Lair hasn't met), or an email (a member's links them;
  anyone else's is invited to make an account, and the games join it when they log in with that email, as when staff
  list a session for a GM). `gm` is the name players see (their name from the search, or their member record, when it's
  left out). The GM's own table moves to them, the sessions show the new GM's own bio (their GM profile's; none yet:
  none), and the series' later sessions are made for them, with that bio.
- A session already credited ("Session done") keeps its GM: 409 for this one, skipped in a series.
- The new GM is emailed "Your game is live" (or the invite), and the GM before, when they had an email, "Your game has a
  new GM".

## 2. Routes

### 2.1 `POST /games/:id/new-seats { seats, scope? }` (staff with GM games, or the session's staff GM)

`seats`: a whole number from 0 to the session's seats (a number, or a number as text). `scope`: `'session'` (the
default) or `'series'`. → `{ game, sessions }` (the board's view of this session; how many sessions changed). Errors, in
this order: `404` game; `401 login`; `403 notYours`; `403 over` (a staff GM, once it's ended); `409` cancelled; `422
newSeats`; `422 scope`.

### 2.2 `POST /games/:id/free { free, scope? }` (staff with GM games)

→ `{ game, sessions, priced, stayFree }` (`priced`: seats booked while it was free that have the price now; `stayFree`:
ones left free because the session's inside the 24 hours or started). Errors: 403 (staff only, or the permission); `422
free`; 404; 409 cancelled; `422 scope`; `409 paidAlready`.

### 2.3 `POST /games/:id/players/:ref/remove` (staff with GM games, or the session's staff GM)

`ref`: the seat booking's reference (or id). → `{ booking: { id, ref, status: 'cancelled', people, name }, refund:
{ due, ask?, amount, covered?, reason, orderId? }, game }` (no email or phone). Errors: 404 game; `401 login`; `403
notYours`; `403 over` (a staff GM, once it's ended); `404 noSeat` (not a seat at this game, or not on any more).

### 2.4 `POST /games/:id/gm { gmCustomerId?, gmCustomerName?, gmEmail?, gm?, scope? }` (staff with GM games)

→ `{ game, sessions, invited?: true, notice? }` (`notice`: that Gobgob emailed them to make an account, or couldn't).
Errors, in this order: 403; 404; 409 cancelled; `409 gmCredited`; `422 gmEmail`; `422 gmWho`; `422 gmName`; `422
gmSame` (the same GM and the same name); `422 scope`.

### 2.5 `POST /games/:id/players` (add players)

Now also for the session's staff GM (in their own game, until it ends: `403 over`). Takes `newPlayer: true` (someone
new staff can't look up).
`booking` adds `newPlayer` (staff said so, or their account or email has never had a seat at a session that started).
The GM isn't emailed about a player they added to their own game themselves.

### 2.6 `GET /floor`

- Each game adds `free`, `newSeats` (kept for new players, at most its seats), `newLeft` (kept seats still open: never
  more than the seats free) and, when free, `seatPrice` 0. `held` (regulars) never includes kept seats, and `taken` is
  booked plus held, so `seats − taken` still counts the kept seats: for someone who isn't new, the seats they can book
  are `seats − taken − newLeft`.
- For whoever can run a game (1.1), `roster`: one item per seat booking still on, first booked first: `{ ref, people,
  names, characters, paid, due (cents), newPlayer, regular, member, here }`. Never an email or phone.
- Staff bookings carry `newPlayer`.

### 2.7 `GET /me`

`customer.newPlayer`: whether they've never had a seat at a session that started (so the kept seats are theirs to take
too). False when logged out.

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `notYours` | Only staff, or the GM of this game when they’re on the team, can do that. |
| `login` | Log in to do that. |
| `over` | That session's over, so ask the staff to change it now. |
| `scope` | scope is 'session' or 'series'. |
| `newSeats` | Seats for new players is a whole number from 0 to 4. (4: the session's seats) |
| `keptAll` | The seats left are kept for players new to our TTRPG sessions. Bringing someone new? Have a chat with us. |
| `keptSome` | Only 2 seats are left for you: 2 are kept for players new to our TTRPG sessions. (1 seat is, 1 is) |
| `free` | free is true or false. |
| `paidAlready` | 1 seat is paid for already, or on a session pass. Refund it (or undo the pass) first, then make it free. (2 seats are … Refund them …) |
| `freeCredit` | This session was free, so there's no GM credit to add. (the credit's note) |
| `priced` | Heads up: Tama's one-shot on Saturday, 17 October at 6:00 pm to 10:00 pm isn't free any more, so your seat is $15.00 on your tab. Can't make it? Cancel it in My Lair by Friday, 16 October at 6:00 pm. (the email to a player, "<title>: not free any more") |
| `noSeat` | That player isn't in this game. |
| `gmWho` | Pick the new GM from the customers, or add their email. |
| `gmName` | Add the name players see for the new GM. |
| `gmSame` | That's the GM already. |
| `gmCredited` | This session's GM credit is done, so its GM stays. |
| `gmEmail` | That email address doesn't look right. |

(`GM_SESSION_WORDS` in `src/gm-sessions.js`.)

## 4. Storage

- `games.free` (0 or 1), `games.new_seats` (0 up), `bookings.new_player` (0 or 1): new columns, made on start when
  missing.
- A series' `details` keep `free` and `newSeats` (from `scope: 'series'`), and `gm`, `gmEmail` and `gmBio` (a new GM),
  so sessions made later follow them.

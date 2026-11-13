# Lair API contract v37-changes: changes people make themselves

14 Nov 2026. From Mo: "I want a way for the users/customers to cancel table bookings down from a number of players to
what ever number so one customer dropped from 9 players to 6 and he was 3 days early so he completely had the chance to
change but wasn't given an option other than cancelling. I want there to be an option to cancel. Also for gms and their
games I want them to have the chance to cancel their games too so long as they are before the 24 hour period and they
even have the chance to change the time and date and given the option to choose to keep that new date or is it a one off
etc."

And at 9:25am, once he'd seen it built at 24 hours for everyone: "Actually let gms cancel within 4 hours before the
session not 24 hours. It's ok. I want people who bought tickets to Thier friends can cancel themselves. Just like gms. So
that it is all working together. Effortlessly. Put it live thanks. With the power for customers who signed up to cancel
up to 24 hours before the session is due and must call us to cancel if it is within that time frame."

Why it happened:

- A customer's own booking took one change, a whole cancel (`POST /bookings/:id/update` answered `Only staff can change
  that booking.` to anything else), so nine people becoming six meant cancelling and booking again, or a phone call.
- A GM could cancel a session, but only from their game's sheet on the board, never from My Lair's Games I run, and by
  another rule than everyone else's: until an hour after it starts (contract v3).
- Only staff could move a session (`POST /games/:id/edit`), and only one session at a time: a weekly game had no way to
  take a new day.
- Found on the way: a weekly or fortnightly game's session that staff moved to another day came back on its old day at
  the next 10-minute run, as a second session (the top-up looked for a session starting on each of the game's dates,
  and the moved one no longer did).

- Someone who booked several seats at a TTRPG session, or signed friends up to an event, had the same one change: cancel
  the lot. One friend dropping out meant cancelling everyone and booking again while the places were free, or a call.

The rules:

- **A customer changes what they booked themselves until 24 hours before it starts** (`refundHours`, the theme's Cancel
  cut-off, as for cancelling since round 15): a table's numbers, and who's coming on seats or a sign-up they booked for
  friends. After that it's locked in, it stays on their tab as it is, and it's a call: staff sort it out.
- **A GM cancels or moves their own session until 4 hours before it starts** (`gmChangeHours`, the theme's GM cut-off,
  `lair_gm_change_hours`; 4 when the theme doesn't have the setting). After that they call the shop. Their players'
  own seats still lock at 24 hours: a GM calling a session off inside that takes the seats with it, and nobody owes for
  one.

The code is in `src/changes.js` (mixed into the Lair), with `updateBooking`, `updateGame`, `editGame`, `planSessions`
and `cancelRule` in `src/lair.js`. Tests: `test/round37-changes.test.js`. Every message below is word for word
(`CHANGE_WORDS`).

## 1. A table booking's numbers, changed by whoever booked it

`POST /bookings/:id/update` with `{ people?, tables? }` and no `status`, from the booking's own account. (With
`status: 'cancelled'` it's their cancel, as before. Staff with the permissions change a booking the staff way, as
before.)

**Which bookings:** their own table booking (`kind: 'table'`) that isn't a game table at an event (`occurrenceId`
null), `confirmed`, not started.

**Until when:** until it's locked in: the booking's own `cancelUntil` (24 hours before, for one with something to pay;
a free one until it starts). One booked inside the 24 hours is locked at once, as it always was.

**What can change:**

- `people`: a whole number from `min` to `max`.
  - `min`: the room's Minimum people (the Fancy room's 4), otherwise 1.
  - `max`: the seats at the tables the booking has, and never more than 24 (the online limit). So a group can shrink, or
    grow into the chairs it already has. A bigger group than that is another booking, or a call.
- `tables`: which of its own tables it keeps. Each has to be one of the booking's tables. Together they have to seat
  everyone, and be no more than that many people may have (the booking rule: enough tables to seat them, double for a
  wargame or big box game; with a library game on the booking, 2 at least).
  - Left out: it keeps its tables when that's within the rule; otherwise the first ones in table order (T2 before T10).
- One of the two at least. Nothing else can be changed this way (the time, the room, other tables).

**What follows:**

- `amount` is the room's price a person times the people; `paid` is worked out again (a smaller group may be paid up).
- Money already on it: when what's been paid and what passes covered come to more than the new amount, it's refused
  and nothing changes. Staff make that change at the counter, with the money back.
- A monthly account: a bigger booking is held to its credit limit as a new booking that size would be (409, the
  booking's own words).
- Tables it lets go are free at once.
- Its library game, its pass and the split-the-bill tick stay as they were. Its notes gain a line for staff, like
  `[Changed online: 9 to 6 people, T8 freed]`, so the desk can see why a table went. It's always whole and last: a
  note from an earlier change goes, and the customer's own notes are cut at their end if both wouldn't fit in 500.
- The booker gets one email, "Your booking's changed" (section 5). Staff aren't emailed.
- Six changes a booking in 24 hours, then it's a call (each one emails the address on the booking, which whoever
  booked it typed). A change that changes nothing isn't counted.
- A table's confirmation and its two-day reminder gain one line while its numbers can be changed (section 5).

**The answer:** `{ booking, changed }`. `booking` is their view of it. `changed` is
`{ people: { from, to }, tables: { from, to, freed }, amount: { from, to } }`, or `null` when what was asked is how the
booking stands already (nothing is saved and nobody is emailed, so a second tap does nothing).

**Their view of a booking** (`GET /me`'s `bookings`, and every answer with their booking in it) has `change` while it
can be changed this way, and not otherwise:

```
change: { until, min, max, each, keep }
```

`until`: the last moment (ms), the booking's `cancelUntil`. `min` and `max`: the people it can have. `each`: cents a
person. `keep`: how many of its tables it may keep at each number of people from `min` to `max` (`keep[0]` is for
`min`).

**Refusals:**

| When | Status | Words |
| --- | --- | --- |
| Not theirs, or something else asked for | 403 | `Only staff can change that booking.` (as before) |
| A TTRPG seat, a game table at an event, a walk-in, or one waiting for an online payment | 409 | `That booking's numbers can't be changed online. Have a chat with us and we'll sort it out.` |
| Cancelled | 409 | `That booking's been cancelled, so there's nothing to change.` |
| Started, or they're checked in | 409 | `That one has already started, so it can't be changed online. Have a chat with us at the counter.` |
| Locked in | 409 | `It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.` |
| `people` isn't a whole number of 1 or more | 422 | `Tell us how many people are coming. To call it off, cancel the booking instead.` |
| Fewer than the room's minimum | 422 | `Fancy room is for groups of 4 or more. To come with fewer, cancel this booking and book another table.` |
| More than its tables seat | 422 | `Your tables seat 8. For a bigger group, book another table or give us a call.` (`Your table seats 4.` for one) |
| A table that isn't the booking's, or none | 422 | `Pick from the tables on this booking.` |
| The tables kept don't seat everyone | 422 | `6 people need more tables than that (those seat 4).` |
| More tables than the group may have | 422 | `That's more tables than 6 people need. Keep up to 2.` |
| Paid or covered for more than the new amount | 409 | `You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.` |
| A seventh change in 24 hours | 429 | `That's 6 changes to this booking today. Give us a call and we'll sort the rest out.` |

## 1b. Seats and sign-ups booked for friends: fewer, by whoever booked them

Whoever booked several seats at a TTRPG session, or signed friends up to an event, takes off the ones who can't come, in
place of cancelling the lot. **Fewer only:** bringing someone else is still a call (a new seat needs a free one, and a
name for its GM). One seat, or a sign-up for one person, has nothing to change here: giving it up is its cancel.

**Until when:** until it's locked in, as cancelling is: 24 hours before it starts for one with something to pay (a seat
whose session moved: until its own `cancelUntil`), until it starts for a free one.

### Seats at a session

`POST /bookings/:id/update` with `{ people, staying? }` and no `status`, from the booking's own account, on a
`kind: 'gm-seat'` booking that's `confirmed` and hasn't started.

- `people`: how many seats it keeps, a whole number from 1 to the seats it has.
- `staying`: which of its players stay, by position from 0 in its players as `GET /me` lists them (`change.who`), each
  once, `people` of them. Left out: the first ones stay (the last go).
- Each seat keeps the price it has (the booking's amount over its seats; nothing while its GM pays for it), `paid` is
  worked out again, and the players named go with the seats.
- The seats it lets go are free at once: back on the board, or kept for the game's regulars as any free seat is.
- A regular's seat (Save my seat every week) changes for that session only: Gobgob saves all their seats again in the
  next one.
- A seat its GM pays for: the GM's charge follows the seats that stay (`syncCover`), and money the GM had paid on it
  for more is a refund due, as when staff change it.
- Money already on it for more seats than it's keeping: refused, staff's to change, with the money back.
- The booker gets **Your booking's changed**, and their GM gets **Seat dropped** with who's still coming (section 5).
- For staff, in the booking's notes after the player's own: `[Changed online: 3 to 2 seats]`.
- Six changes a booking a day (the table's limit).

**The answer:** `{ booking, changed }` with `changed: { people: { from, to }, players: { from: [names], to: [names] },
amount: { from, to } }`, or `changed: null` when it's how it stands already (nothing saved, nobody emailed).

`GET /me`'s `seats` each have `change: { until, min: 1, max, each, who: [{ name, cost }] }` while they can: `max` the
seats it has, `each` what a seat costs its player now, `who` its players in order.

**Staff's own way** (`POST /bookings/:id/update` with the permissions, as before, any time): fewer people on a seat now
takes the players named with them too, the ones `staying` names or the first ones, so the GM's list of players never
shows someone who isn't coming. Someone on the team changing their own seats in My Lair goes this way.

| When | Status | Words |
| --- | --- | --- |
| Not theirs | 403 | `Only staff can change that booking.` (as before; `tables` on a seat too) |
| Cancelled | 409 | `That booking's been cancelled, so there's nothing to change.` |
| Checked in, or started | 409 | `That one has already started, so it can't be changed online. Have a chat with us at the counter.` |
| Locked in | 409 | `It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.` |
| Locked in, and its GM pays for it | 409 | `It's less than 24 hours away, so it can't be changed online now. Your GM pays for your seats if you come. Have a chat with us at the counter or give us a call, and we'll sort it out.` |
| `people` isn't a whole number from 1 | 422 | `Tell us how many seats to keep. To give them all up, cancel the booking instead.` |
| More seats than it has | 422 | `To bring someone else, give us a call or ask at the counter. Here you can give seats up.` |
| `staying` isn't that many of its players | 422 | `Pick who's still coming: one name for each seat you're keeping.` |
| More paid on it than the new amount | 409 | `You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.` |
| A seventh change in 24 hours | 429 | `That's 6 changes to this booking today. Give us a call and we'll sort the rest out.` |

### An event sign-up

`POST /events/joins/:id/change` with `{ people, staying? }`, from whoever signed up, on a sign-up that's `confirmed`,
on their tab (never one paid online, from before round 15: that's locked in, and staff decide on money back) and hasn't
started.

- `people`: how many are coming now, themselves counted: a whole number from 1 to its people.
- `staying`: which of the people coming with them stay, by position from 0 (its guests in order, then friends without
  names, as `change.who` lists them), each once, `people - 1` of them. Left out: the first ones stay.
- Each place that stays is priced as the door would price it today (`memberEntryAtDoor`): at an event free for library
  members, the account holder's place, and a guest's added by member code, is free while their plan lets them borrow;
  every other place costs what a paying place cost when they signed up. So taking off a free guest changes nothing to
  pay, and taking off a paying one takes their entry off. `member_free` and `free_guests` are written to match.
- The guests taken off leave the sign-up (and it leaves their My Lair); the places are free at once.
- Money already on it for more than the new amount: refused, staff's to change, with the money back.
- They get **Your booking's changed** (section 5). Nobody else is emailed. For staff, in the sign-up's note:
  `[Changed online: 3 to 2 people]`.
- A sign-up whose date isn't on the calendar any more, or with free places from a rule the date no longer has, isn't
  changed here.

**The answer:** `{ ok, join, changed }` with `changed: { people: { from, to }, guests: { from: [names], to: [names] },
amount: { from, to } }`, or `changed: null`.

`GET /me`'s `joins` each have `change: { until, min: 1, max, each, you, who: [{ name, cost }] }` while they can: `you`
what their own place costs today, `who` everyone coming with them in order (`name: ''` for a friend without one).

| When | Status | Words |
| --- | --- | --- |
| No such sign-up | 404 | `Sign-up not found.` |
| A guest on it | 403 | `Only the person who signed up can change this. Ask them, or the counter.` (as cancelling) |
| Anyone else, staff too | 403 | `Only whoever signed up can change who's coming.` |
| Cancelled | 409 | `That sign-up's been cancelled, so there's nothing to change.` |
| Held for a payment, paid online, its date gone, or free places from another day's rule | 409 | `That sign-up can't be changed online. Have a chat with us and we'll sort it out.` |
| Checked in, or started | 409 | `That one has already started, so it can't be changed online. Have a chat with us at the counter.` |
| Locked in | 409 | `It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.` |
| `people` isn't a whole number from 1 | 422 | `Tell us how many people are coming. To call it off, cancel your sign-up instead.` |
| More people than it has | 422 | `To bring someone else, give us a call or ask at the counter. Here you can take people off.` |
| `staying` isn't that many of them | 422 | `Pick who's still coming with you.` |
| More paid on it than the new amount | 409 | `You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.` |
| A seventh change in 24 hours | 429 | `That's 6 changes to this booking today. Give us a call and we'll sort the rest out.` |

Staff still change a sign-up as before (cancel it, or add one): there's no staff change of its people yet.

## 2. A GM cancels a session until 4 hours before it starts

`POST /games/:id/update` `{ status: 'cancelled', scope? }` from the session's GM. This replaces "until an hour after it
starts" (contract v3). Staff with GM games cancel at any time, as before.

- A session: while it's more than 4 hours away (`gmChangeHours`). After that, and once it's started: 409
  `It's less than 4 hours away, so it can't be cancelled online now. Give us a call or see us at the counter, and we'll sort it out with your players.`
- Inside its players' own 24 hours their seats are locked in, and a GM's cancel still takes them with it: each seat is
  cancelled, nobody owes for one, and anyone who'd paid is flagged "refund due", as a cancelled game always was.
- `scope: 'series'`: every session they run that's more than 4 hours away is cancelled, and the game stops adding
  dates (when the series is theirs), as before. A session less than 4 hours away stays on, and the answer says so:
  `kept: [{ id, start, when }]` and `notice`, for example
  `Saturday, 21 November at 6:00 pm is less than 4 hours away, so it's still on. Give us a call if it can't run.`
  (`Those sessions are` for more than one, with each date). One that's already under way stays on too, and isn't
  named: it isn't away, it's on.
- Everything a cancel does is as before: every player's email, paid seats flagged "refund due", the GM's charges.
- `GET /me`'s `games` each have `changeUntil` (ms): the last moment their GM can cancel or move that session online
  (4 hours before it starts).

## 3. A GM moves a session

`POST /games/:id/move` `{ start?, end?, tables?, scope? }`: the session's GM, or staff with GM games. One of `start`,
`end` and `tables` at least. `start` without `end` keeps how long it runs.

- **Who and when.** Its GM, while the session is more than 4 hours away (`gmChangeHours`, as for cancelling). Staff
  with GM games, until it ends. A session that's cancelled can't move.
- **The new place** follows the GM rules, as listing a game does: opening hours, whole hours (a time that isn't
  changing isn't held to them), tables that are free then with room for its players (its own bookings don't count),
  no tables an event has locked, the shop tables only for staff (or the ones staff gave the game), and for its GM
  the lead time and how far ahead the Lair books. Staff skip those last two, as Edit session does.
- **A move keeps the price.** New tables have to be in a room with the same table fee, so no player's price changes by
  it. (Staff change a session's room, and its price with it, with Edit session.)
- **A day's notice.** When the time changes and anyone has a seat (or a regular's seat is saved), a GM's new time has to
  be at least 24 hours away (`refundHours`, the players' own). A session with nobody on it yet needs only the lead time.
  So a GM who moves a session inside its players' 24 hours can only move it a day or more on, and each player gets
  their day to drop out (below).
- **Between its neighbours.** In a series, a session stays after the session before it ends and before the one after it
  starts. To go further, cancel it and add a date.
- `scope`:
  - `'session'` (or none): this session only. In a weekly or fortnightly game, the date it leaves stays its date: the
    game doesn't put another session there (`games.slot_day`).
  - `'series'`: a weekly or fortnightly game, by whoever runs the series. This session moves, and the game takes its
    new day, time and length from here on (and its new tables, when `tables` is sent): every later session they run
    that hasn't started and is on the game's usual day and time moves by the same number of days to the new time,
    where its tables are free then. One that can't keeps its time and is listed in `kept` with why; so is one that was
    moved on its own before. The sessions the game adds later follow the new day and time. The new day has to be less
    than a week (a fortnight) from the old one.
- **Everything on it moves with it:** the GM's hold, every seat that's still on, and a GM's charge for a player's seat
  (its times; it has no table).
- **Players can still drop out.** A seat whose time changed can be cancelled by its player until 24 hours after the
  move, or until it starts if that's sooner, even when that's inside the usual 24 hours (`bookings.moved_at`; the seat's
  `cancelUntil` says so everywhere it's shown). The same now holds when staff move a session with Edit session.
- **Who hears** (section 5): everyone with a seat on a session whose time changed, and the regulars whose seats there
  are saved but not booked yet (every regular, for `'series'`). When its GM made the move, the team gets one email.
  New tables at the same time email no player, as before.
- **Five changes a game in 24 hours** by its GM (a whole series is one game), then it waits for tomorrow or the team.
  Staff aren't counted.

**The answer:** `{ game, scope, moved, kept, told }`. `game`: the session as it is now. `moved`: how many sessions
changed (this one counted). `kept`: `[{ id, start, when, reason }]`, the later sessions that stayed. `told`: how many
people were emailed. Asking for where it is already answers with `moved: 0` and changes nothing.

**Refusals:**

| When | Status | Words |
| --- | --- | --- |
| Not its GM or staff with GM games | 403 | `Only the GM or staff can move a session.` |
| Cancelled | 409 | `That game was cancelled. List it again as a new game.` (as Edit session) |
| Over | 409 | `That session's over, so there's nothing to move.` |
| Nothing to change sent | 422 | `Pick the new day, time or tables.` |
| A time that isn't one | 422 | `That time is not valid.` (as a booking) |
| `scope` isn't one of the two | 422 | `Choose whether it's just this session or every later session too.` |
| `'series'` on a one-off or a flexible game | 422 | `Only a weekly or fortnightly game has a usual day to change. Move this session on its own.` |
| `'series'` by a GM the series isn't theirs | 403 | `Only staff, or the GM who runs this game, can change every later session.` |
| `'series'` from a session that isn't on the game's usual dates | 422 | `This session was moved on its own before. Open one that's on the game's usual day to change every later session.` |
| A GM, less than 4 hours before it starts | 409 | `It's less than 4 hours away, so it can't be moved online now. Give us a call or see us at the counter, and we'll sort it out with your players.` |
| A GM, a time inside the lead time | 422 | `That's too soon. Pick a later time.` |
| A GM, players on it and the new time under 24 hours away | 422 | `Your players need a day's notice. Pick a time at least 24 hours from now.` |
| Tables in a room with another table fee | 422 | `Those tables are in a room with a different table fee, which would change what your players pay. Pick tables in the same room, or ask the team.` |
| A GM's sixth change to the game in 24 hours | 429 | `That's 5 changes to this game today. Try again tomorrow, or ask the team to help.` |
| Past a neighbour | 422 | `Keep it between the sessions before and after it: after Saturday, 14 November at 10:00 pm and before Saturday, 28 November at 6:00 pm. To move it further, cancel it and add a new date.` (only the side there is) |
| `'series'`, a week or more from its day | 422 | `That's a week or more from its usual day. Pick a day closer to it, or cancel sessions and add new dates.` (`a fortnight or more` for a fortnightly game) |
| The place itself | 409 or 422 | The GM rules' own words, like `Table B3 is already taken at that time. Pick another.` |

Why a later session stays (`kept[].reason`): the GM rules' own words, or
`It was moved on its own before, so it stays where it is.`, or `Another GM runs it, so it stays where it is.`

## 4. Elsewhere

- **A weekly or fortnightly game never puts a second session on a date one left** (`games.slot_day`: the game's date a
  session fills when it isn't the day it starts on). The top-up counts both. Staff's Edit session keeps it too, which
  fixes the twin: a session moved to another day used to come back on its old day within 10 minutes.
- **`cancelRule`:** for a seat whose session moved, the later of 24 hours before it starts and 24 hours after the move
  (never after it starts). Nothing else about the lock changes.
- **Edit session's "New time" email** ends with the seat's own cancel line (below) in place of "Less than 24 hours
  away? Have a chat with us and we'll take it off your tab.", and goes to the regulars whose seats there are saved but
  not booked yet as well.
- **The limits** are counted in `messages`, as a GM's messages to players are (`limit_key` `ch:<booking id>` and
  `mv:<series or game id>`).
- **New columns**, made sure of on every start: `bookings.moved_at` (when its session's time last changed under it),
  `games.slot_day` (`YYYY-MM-DD`).
- **The GM cut-off** is a rule like the cancel cut-off: `rules.gmChangeHours`, from the theme's `lair_gm_change_hours`
  (Theme settings › Lair bookings › GM cut-off), 4 when it's missing, empty or not a number.
- **`GET /floor`'s `features.changes: true`** says this Lair app takes `POST /games/:id/move`. The games board offers
  "Change date or time" only when it's there, so a newer website on an older Lair app never shows a button that can't
  answer. My Lair goes by `change` on a booking and `changeUntil` on a game the same way.

## 5. The emails

All transactional: each is about a booking or seat the person has. Signed by Gobgob, with See it in My Lair. Dates
are written as the Lair's other emails write them.

**Your booking's changed** (to the booker, when section 1 changes something):

- Subject: `Booking changed: 6 people on Tuesday 17 November` (`Booking changed: Table T11 on Thursday 19 November` when only its tables changed)
- Title: `Your booking's changed`
- `Kia ora Mia Chen, Gobgob has updated your table at the Dice Goblin Lair.`
- Details: `When`; `People` (`6 (it was 9)`); `Where` (`Tables T6, T7`, and when some went `Tables T6, T7 (T8 is back on the map for someone else)`); `Fee` (`$60.00, on your tab (it was $90.00)`; part paid: `$40.00 left on your tab ($20.00 of $60.00 paid)`; paid up: `$20.00, paid. Thank you!`).
- Then the booking's own tab lines (what's to pay and how, and until when it can be cancelled).
- For seats (section 1b): subject `Booking changed: 2 seats on Tuesday 17 November`,
  `Kia ora Mia Chen, Gobgob has updated your seats at Curse of Strahd.`, and details `Game`, `When`, `Seats`
  (`2 (it was 3)`), `Players` (who's still coming), `Where`, `Fee` (`$30.00, on your tab (it was $45.00)`; `Nothing to pay`
  while their GM pays).
- For a sign-up: subject `Booking changed: 2 people on Sunday 29 November`,
  `Kia ora Mia Chen, Gobgob has updated your sign-up for Blood on the Clocktower.`, and details `Event`, `When`, `People`
  (`2 (it was 3)`), `Coming` (who's still coming), `Entry` (`$20.00, on your tab (it was $30.00)`).

**Seat dropped** (to the session's GM, when a player keeps some of their seats; a whole seat dropped has its own, as
before):

- Subject: `Seat dropped: Curse of Strahd, Tuesday, 17 November at 6:00 pm to 10:00 pm` (the whole drop's subject)
- Title: `A player gave up a seat`
- `Kia ora Rangi, Mia Chen dropped 1 of their 3 seats at Curse of Strahd. The spot's back on the games board for someone else.`
  (`The spots are back …` for more than one; `Gobgob's keeping the spot for one of your regulars.` when it's held).
- Details: `Game`, `When`, `Still coming` (the players who stay), `Seats taken` (`2 of 4`).

**One more line, while its numbers can be changed** (a table that's its own account's, not at an event; a booking for
more than one seat; a sign-up for more than one person on their tab; none of them locked in):

- After the confirmation's cancel line: `Numbers changed? Update them in My Lair by then too.`
- At the end of the two-day reminder's cancel paragraph: `Can't make it? Cancel free until 6pm Monday and your table goes back for someone else. After that, the $90 stays on your tab. Numbers changed? Update them in My Lair by then too.`
- For one with nothing to lock: `Numbers changed? Update them in My Lair any time before it starts.`

**New time** (one session moved, by its GM or by staff with Edit session: to each seat on it, and to each regular whose seat there is saved but not booked yet):

- Subject: `New time: Curse of Strahd, Sunday, 6 December at 1:00 pm to 5:00 pm`
- Title: `Your game has a new time`
- `Heads up, friend: Curse of Strahd has moved. Your seat moved with it.` A regular's saved seat: `Heads up, friend: Curse of Strahd has moved. Gobgob saves your seat at the new time.`
- Details: `Game`, `Now`, `Was`, `Where`.
- The seat's cancel line: `Can't make the new time? Cancel your seat in My Lair by Saturday, 5 December at 1:00 pm and Gobgob will let your GM know. After that it stays on your tab.` A seat its GM pays for ends `After that it's locked in.` A free seat: `Can't make the new time? Cancel your seat in My Lair any time before it starts and Gobgob will let your GM know.` A seat with no account: `Can't make the new time? Reply to this email or give us a call by Saturday, 5 December at 1:00 pm.` (`before it starts.` for a free one). A regular's saved seat: `Can't make the new time? Skip a session or stop saving your seat in My Lair.`

**New day and time** (`scope: 'series'`, once to each person with a seat on a session that moved, and to each regular):

- Subject: `New time from Friday 27 November: Curse of Strahd`
- Title: `Your game has a new time`
- `Heads up, friend: Curse of Strahd is moving to Fridays at 7pm, from Friday 27 November.` (`every second Friday at 7pm` for a fortnightly game)
- Details: `Game`; `Now` (`Fridays, 7pm to 11pm`); `Was` (`Saturdays, 6pm to 10pm`); `Your seat` (each seat's new time; `Your seats` for more than one), or for a regular with none there `Your seat` (`Gobgob saves it at the new time`); `Staying put` (later sessions that kept their time, when there are any).
- With a seat: the earliest seat's cancel line, as above. A regular with none: `Can't make the new time? Skip a session or stop saving your seat in My Lair.`

**A GM moved a session** (to the team, `STAFF_EMAIL`, when its GM made the move):

- Subject: `Moved by its GM: Curse of Strahd`
- `Rangi moved Curse of Strahd from Saturday, 5 December at 6:00 pm to 10:00 pm to Sunday, 6 December at 1:00 pm to 5:00 pm.` With `'series'`: ` Every later session moves with it: Fridays at 7pm from now on.` Then ` 1 person was told by email.` or ` Nobody had a seat, so there was no one to tell.` New tables at the same time: `Rangi moved Curse of Strahd from Table B1 to Table B3, at the same time: Saturday, 5 December at 6:00 pm to 10:00 pm.`
- Details: `Game`, `Was`, `Now` (each with its tables), and `Staying put` (later sessions that kept their time, with why).

## 6. The website

In the lab first (`website-lab`), then the preview and live with Mo's yes. The theme's demo answers as this contract
does, with the same words.

- **My Lair, a table's ticket:** **Change numbers** beside Add to calendar while the booking carries `change`, and
  the line beside Cancel booking reads `Change or cancel by Mon 16 Nov, 6pm` (one moment for both). The dialog,
  "How many are coming?": the tables and the time, a stepper from `min` to `max`, `6 people · $60 (it was $90)`, and,
  when that many may keep fewer tables (`keep`), "Which table goes back?" with a chip a table (the last ones unless
  they pick), then `Change it again any time until Mon 16 Nov, 6pm.` **Update booking** sends `{ people, tables }`.
  After: `Updated: Tables T5 and T6 for 6, Tue 17 Nov. T4 is back on the map for someone else. It's $60 now.` The Lair
  app's refusals show in the dialog in its words; after a 409 the page looks again when the dialog closes.
- **My Lair, seats and sign-ups booked for friends** (a seat's ticket, a regular's card for its next session, and a
  sign-up's ticket, while each carries `change` with `who`): **Change numbers** beside Add to calendar, and
  `Change or cancel by …` beside the cancel link. The dialog, "Who's still coming?": the game or event and the time, a
  tick for each player on the seats ("On your seats") or each person coming with them ("Coming with you"; a friend
  without a name is "A friend"), `Untick anyone who can't come.`, `2 seats · $30 (it was $45)`, then
  `A seat you give up goes back on the board for someone else. Change it until Mon 16 Nov, 6pm. Bringing someone else? Give us a call or ask at the counter.`
  (`A place you give up goes back for someone else. …` for a sign-up). Nobody ticked on seats:
  `Keep one seat at least. To give them all up, give up your seats instead.` A regular's card adds
  `It's just for this session: Gobgob saves your 2 seats again for the next one.` **Update booking** sends
  `{ people, staying }`. After: `Updated: 2 seats at Curse of Strahd, Tue 17 Nov. One seat is back on the board for someone else. It's $30 now.`
  (`Updated: 2 people for Blood on the Clocktower, Sun 29 Nov. One place is back for someone else. It's $20 now.`).
- **My Lair, Games I run**, on each game while it carries `changeUntil`: **Change date or time** (a link to the
  board, `?move=1#game=<session id>`), **Open game** (`#game=<session id>`), **Cancel this session**, **Cancel all
  future sessions** (a weekly, fortnightly or flexible game with another session to cancel) and
  `Change or cancel by Tue 17 Nov, 6pm`. Cancelling asks first in a dialog: who has a seat, who hears, any session too
  close to cancel (it stays on), and that it can't be undone. Less than 4 hours away: `Too close to change online` with
  `It's less than 4 hours away, so it can't be moved or cancelled online now. Give us a call or see us at the counter, and we'll sort it out with your players.`
  in place of the buttons. Someone on the team isn't held to the 4 hours (the Lair app decides).
- **The games board, a GM's own game:** **Change date or time** among its buttons while `GET /floor` says
  `features.changes`, and under them `Can't run it? Cancel up to 4 hours before it starts. Everyone with a seat gets an email, and anyone who's already paid gets a refund.`
  (staff: `Staff can cancel a session until it ends. …`). The sheet has the day, time and table picker starting where
  the session is, with its own tables free to it and, for its GM, nothing sooner than the lead time (24 hours once
  anyone has a seat); a weekly or fortnightly game asks **Which sessions?**: `Just this session` (a one-off) or
  `This and every later session` (the game's new day and time). After: `Moved to Thursday 19 November, 6pm to 10pm. Gobgob emailed 2 people the new time.`,
  with `Every later session moves with it.` and each session that stayed, with why.
- **The GM cut-off on the website** is the theme's own setting (`lair_gm_change_hours`, 4), which the Lair app reads
  too, so the board's words and the Lair app's rule are one number. My Lair goes by the Lair app's `changeUntil`.
- **A newer website on an older Lair app** shows none of it: no `change`, no `changeUntil`, no `features.changes`.

# Lair app API: round 9, play (9 Oct 2026)

**Changes only**, on top of `lair-api-contract-v8.md` and everything before it. Money in cents, times in ms (UTC), days
in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Builder: play (backend `r9-play-api`, theme `r9-play`). Mo (9 Oct 2026): "book a table, book a ttrpg or event, can all
live in the same page with the live table view … have the option to click on games with spaces in them to say you are
interested in joining or others can have an option to register interest and the gm will get back to you", and "events
for card games etc. where you say you are coming or even planning on coming … so that we can get rough numbers".

The one booking page (Tables, TTRPG sessions and Events tabs, the month view and the live table map) is theme work
that reads `GET /floor` as before: see "Busy days" below. This file is the Lair app's half: interest.

---

## 1. "I'm interested" and "Maybe"

### Rules
- **One row per person per session or event date** in the new `interests` table: by their account when logged in, or
  by their email (ignoring case). Asking again changes the note (and, for an event date, maybe ↔ coming): it never
  makes a second row and never emails the GM twice.
- **Levels:** a TTRPG session gets `interested` (one with seats they'd rather ask about first, or a full one). An event
  date gets `maybe`; one that takes no sign-ups (no capacity and no game tables, like a TCG night where entry is a
  booster pack) can also get `coming` ("I'm coming"), so the shop gets rough numbers. For an event with sign-ups,
  "I'm coming" is the sign-up (`POST /events/:id/join`, v8), unchanged.
- **Who:** anyone. A logged-in member's name and email fill in from their account when left out (a mobile is
  optional); a guest gives a name, an email and a mobile (checked as on sign-ups, v7).
- **Nothing is booked.** A session's GM is emailed and gets back to them; the person takes a seat as usual.
- **Taking it back:** the member it belongs to, staff, or a guest with the `key` the answer gave them (the theme keeps it
  in that browser). A taken-back row stays, with `status: 'removed'`.
- **Already in:** someone with a live seat at the session, or a live sign-up or game table on the date (by account or
  email), is told so (409).
- **Adoption:** interest left with an email joins the account when they log in with it (`GET /me`, as
  `adoptGuestBookings`), from 30 days back. If they already had one for the same session or date by account, the
  newer one is taken back, so they're counted once.
- **Rate limit:** the same soft limit as bookings and sign-ups (20 in 10 minutes from one address; staff aren't
  limited): 429 "Too many bookings in a short time. Call us and we will sort it out."
- **Public answers carry counts only, never names.**

### Routes
- **`POST /interest`** (anyone) `{ kind: 'session' | 'event', id, note?, coming?, name?, email?, phone? }`
  - `id`: the game's id (a session) or the occurrence id `handle@YYYY-MM-DD` (an event date).
  - `note`: up to 280 characters. `coming: true` for "I'm coming" on an event date with no sign-ups.
  - Answer `{ interest, counts, already, emailed }`:
    - `interest`: `{ id, kind, targetId, level, status, name, note, title, start, end, at }`, plus `key` when it's a
      guest's (no account): the secret that takes it back from that browser.
    - `counts`: `{ interested }` for a session, `{ maybe, coming }` for an event date.
    - `already`: true when it was theirs already (the note or level changed). `emailed`: the GM (or staff) was emailed.
  - Errors, word for word:
    - 422 "Say whether this is for a TTRPG session or an event."
    - 404 "That session could not be found. It may have finished or been cancelled." (unknown, pending or cancelled)
    - 404 "That event date could not be found."
    - 422 "That one has already finished."
    - 422 "That's your own game, friend. Your players can say they're interested." (the session's GM)
    - 422 "This one takes sign-ups, so sign up to keep your place." (`coming` on an event with a capacity or game tables)
    - 422 "Keep the note to 280 characters."
    - 422 "Add your name."
    - 422 "Add your email so we can get back to you."
    - 422 "Add a mobile number so we can reach you on the day." / "That mobile number doesn't look right. Try one like
      021 123 4567." (v7's mobile check; required for guests only)
    - 409 "You already have a seat in this session. It’s in My Lair."
    - 409 "You’re already signed up for this one. It’s in My Lair."
    - 429 as above.
- **`POST /interest/:id/remove`** (the member it's theirs, staff, or a guest) `{ key? }` → `{ ok: true, interest, counts }`.
  Taking back one already taken back answers the same.
  - 404 "That could not be found. It may have been taken back already."
  - 403 "That isn't yours to take back."
- **`GET /me`** adds `interests`: their active ones for sessions and dates still to come, soonest first, each as
  `interest` above (no key).
- **`GET /floor`** adds:
  - each game: `interested` (how many, for everyone); for staff and the session's own GM, `interest`:
    `[{ id, name, email, phone, note, at, member }]`, oldest first. (The person asked the GM to get back to them, so
    the email and mobile go with it, as in the GM's email.)
  - `eventInterest`: `{ [occurrenceId]: { maybe, coming } }`, for everyone.
  - staff only, `interests`: every event date's interest in the range, `[{ id, name, email, phone, note, at, member,
    kind: 'event', level, occurrenceId, gameId: null, title, start, end, customerId }]`, for the Events tab and Today's
    sign-ups.

### The GM's email
To the session's GM email (or, with none on file, to STAFF_EMAIL "so please pass this on"), when someone new is
interested, never again for the same person. Reply-to: the person's email.
- Subject: "Ruby is interested in Curse of Strahd on Thu 15 Oct" (their first name, the title, the day).
- Title "Someone wants in!"; intro "Kia ora Ana, Ruby Tane is interested in Curse of Strahd on Thu 15 Oct. There are 2
  seats left. Nothing is booked yet: get back to them and they can take a seat." (full: "It’s full, so they’d like to
  hear if a seat comes up."); details Name, Email, Mobile, Their note, When, Seats left; "Reply to this email to get
  back to them."; the games board button; signed Gobgob (a Lair email to a GM, like "A new player for your game!").

### Storage (one migration entry, appended)
`interests (id, kind, target_id, level, status, name, email, phone, note, customer_id, remove_key, title, starts_at,
ends_at, notified_at, created_at, updated_at)`, indexes on (kind, target_id, status), (ends_at, starts_at),
(customer_id, ends_at), and a unique index on (kind, target_id, lower(email)) for active rows. Nothing existing changes.

### Staff routes
None new. Staff read interest on `GET /floor` (staff view), as they read sign-ups; taking one back uses
`POST /interest/:id/remove`, which staff may call for anyone's (the same gate as the customer route, plus staff).

| Route | Who | Permission |
|---|---|---|
| (none new) | | |

---

## 2. Busy days on the month view (no new route)
The booking page's month view shades each open day by how busy it is from what `GET /floor` already sends for the
booking horizon (the store loads it in one request): table-hours booked (active bookings, TTRPG sessions' tables) or
held (staff holds and locked event tables) during opening hours, over the bookable tables × open hours. Event tables
that are only set aside (soft) don't count as busy; they show as event marks. Steps: Quiet (under 25%), Filling (25%
to 50%), Busy (50% to 80%), Full (80% or more, or no free table at any time that day). Closed days are greyed. No
summary route was needed, so none was added.

## Contract notes
- "I'm coming" for events without sign-ups is a count (`level: 'coming'`), not a ticket: those events are "just turn
  up", so a sign-up with a QR code would promise a place that doesn't exist. Events with a capacity keep their sign-up.
- A guest's interest can only be taken back from the browser that made it (its key) or by staff; once they make an
  account with that email it's theirs, and My Lair can take it back.
- The GM sees the person's email and mobile with their interest (unlike a player's, which a GM never sees on the board):
  the person asked the GM to get back to them, and the form says so.
- The proxy's "known route" list for the status page (`fetch()`'s `known`) was left alone to keep the merge small, so
  `POST /interest` shows there as an unknown path until it's added (one word).

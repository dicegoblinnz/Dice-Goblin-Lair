# Lair API contract v12-sim: what the website simulation found

Round 12 (10 Oct 2026). Mo: "Can you run a simulation and check if there is any bugs or issues in the website and help
identify and fix any of them. Including any inconsistency or works that apply on the backend corrupting the front end."
The store's own events and GM games on a local copy (`tools/qa/sim/sim.mjs`), walked through as a visitor, a member and
staff on a phone and a desktop, with changes made behind their backs (a picture taken away, a session cancelled, an
event deleted in Shopify).

## 1. The series top-up (every maintenance run)

- `planSessions` leaves a session that starts after the booking horizon (later in the day than now, on the horizon's
  last day) for a later top-up. It used to report it as skipped: the owner's `games.add` listed it, and the top-up told
  staff the game "needs a table".
- `extendSeries` runs on every maintenance run (it was once a day, by a note kept in memory only, so a Lair that had
  been asleep ran it again). A session is added as soon as its start is inside the horizon, which is when tables
  can be booked for it.
- A date a series can't have (its tables taken, an event locking them, like Oddity Alley's whole floor) is tried again
  each run. Staff get "Game series needs a table: <title>" once for each date: the table **`series_skips`**
  (`series_id`, `day`, `reason`, `told_at`) remembers which they've been told about (kept until a week after the date).
  Maintenance's answer lists `series` only for runs that added sessions or found new dates.

## 2. Event dates that went from the calendar in Shopify

The staff page won't move or delete a date people are on, but Shopify's own editor will (deleting the entry, making
it a draft, changing its dates, repeat or skip dates).

- Maintenance looks for event dates still to come that have sign-ups, game tables, I'm coming, maybe or waitlist
  places but aren't on the calendar any more. Nothing is cancelled and nobody is emailed but staff: one email for each
  such date, "Not on the calendar any more: <title>, <Sun 18 Oct>", with how many are on it and who (sign-ups and game
  tables with their codes, emails and mobiles, and the waitlist). Put the date back and it's all as it was. The table
  **`gone_dates`** (`occurrence_id`, `title`, `starts_at`, `told_at`) remembers the dates told about; a date that comes
  back is forgotten, so going again tells staff again. Maintenance's answer lists them as `goneDates`.
- Only with the events read from Shopify: a Lair that couldn't reach Shopify (the built-in defaults, no events) never
  counts every date as gone.
- `GET /me`: a sign-up (`joins`), a game table (`bookings` with an `occurrenceId`) or an event interest (`interests`)
  on such a date has **`gone: true`**. My Lair keeps it, flagged "Not on the calendar now", with a note to expect the
  team to be in touch, and offers no reminder for it. Reminders were already never sent for a date that's gone.
- The theme: a link to a date that's gone (`#event=<handle>@<date>`, still to come, inside the horizon) opens a sheet
  saying so instead of nothing; a session's link (`#event=game:<id>`) too, when the app answered.

## 3. Players already in a game's group, on the staff page

- `GET /floor` for staff: each game has `offlinePlayers` (the players its group already has, who don't book through
  the Lair and are counted in `taken`). The public floor doesn't have it.
- The staff page's Players says "5 players already in the group, not booked here" instead of "No players yet."

## 4. The theme's words

- Times say `12pm`, not `noon`, everywhere (the calendar, its sheets, My Lair, the booking pickers), as the repeat tags,
  What's on and the emails already did; `midnight` stays.
- What's on (Liquid) says `midnight`, not `12am`: "Weekly · Thursdays 6pm to midnight".
- A held or set-aside note starts with a capital: "The party room and F1 are held for games night."
- The home page's Events card: "TCG nights, Warhammer, Blood on the Clocktower and the monthly Oddity Alley market."

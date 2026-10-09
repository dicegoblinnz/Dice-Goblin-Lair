# Lair API contract v11-admin: events over several days, the owner's jobs, players already in a game

Round 11 (9 Oct 2026). Mo: "remove all the gm games and all of the events and other things and add the following …
Oddity Alley third Saturday and Sunday of each month … book out the entire floor t1-t21 … Can you help create all the
events and GM games and have images for all of them". This covers the coordinator's part; Warhammer game tables are in
v11-warhammer and the reminders and waitlist in v11-reminders.

## 1. Events that run several days in a row (`days`)

- `lair_event` has a new field **`days`** (number_integer, "Runs for (days in a row)", 1 to 7; empty is 1). Each of the
  event's dates then runs that many days in a row, with the same hours, tables, places and price each day.
- **Each day is its own date** with its own id: `oddity-alley@2026-11-21` and `oddity-alley@2026-11-22`. Sign-ups,
  game spots, "I'm coming", "Maybe", reminders, the waitlist and table holds all work per day, exactly as for any date.
- Repeats count from the first day: monthly is the nth weekday of the first date (the third Saturday), and its second
  day is the day after (the Sunday after the third Saturday, whichever Sunday of the month that is). Skip dates skip
  a whole date by its first day.
- Words: the repeat tag says both days, `Monthly · Third Saturday and Sunday 10am` (weekly: `Weekly · Saturdays and
  Sundays 10am`; longer: `Monthly · Third Saturday (3 days) 10am`). A one-off over two days: `Sat 21 Nov and Sun 22 Nov,
  10am–4pm each day`. Tags say `12pm`, never `noon`.
- `GET /events` (staff) entries and their `config` carry `days` (1 when empty). `POST /events` and
  `POST /events/:handle/update` take `days` (1 to 7; 1 or empty clears the field). Refused with **"An event runs for 1
  to 7 days in a row."** (422).
- The theme: `lair-config` writes `"days"`; a one-off stays in it until its last day is over. The staff editor has
  **Runs for** (1 day, 2 days in a row … 7). What's on (Liquid) and its Event JSON-LD say both days and end on the last.

## 2. The owner's jobs (`admin_jobs` in the config database)

For bulk changes there's no page for. Only someone who can write to the config database (the Cloudflare account) can
queue one; the public proxy never reaches `/internal`.

- Table (made by the Worker if missing): `admin_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
  DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at INTEGER, done_at INTEGER)`.
- Each cron run (every 10 minutes) claims up to five `pending` rows, oldest first (`status` → `running`, so overlapping
  runs never do one twice), runs each once in the Lair (`POST /internal/admin-job`), and writes back `done` or `failed`
  with the result as JSON and `done_at`. A failed job is never retried: add a new row.
- No job sends any email.

| kind | payload | does | result |
|---|---|---|---|
| `games.reset` | `{}` | every GM game and series off the board: games and series cancelled, GM table holds and seats cancelled, regulars and seat invites ended, interest in sessions closed | `{ games, series, bookings }` (counts before) |
| `events.reset` | `{}` | every sign-up, game spot, "I'm coming", "Maybe" and waitlist place for event dates still to come cancelled; ones paid online are left for staff | `{ joins, spots, interests, paidLeft: [{ ref, kind, title, start }] }` |
| `games.update` | `{ updates: [{ seriesId \| gameId, set }] }` (1 to 60) | a game's details for every session still to come of its series (or the one game), like a staff edit: `set` takes any of `title`, `system`, `gm`, `blurb`, `seats`, `offlinePlayers`, `level`, `age`, `tags`, `characters`, `bring`, `gmFee`, `imageUrl` (a `https://cdn.shopify.com/…` picture, or `null`); the GM's table hold follows the seats; later top-ups carry the change. Refused per change: seats below the players booked plus `offlinePlayers` ("<when> already has N players booked, so it needs at least M seats."), more players in the group than seats, a picture that isn't in Shopify Files, an unknown series | `{ updated: [{ id, title, sessions, seats, offlinePlayers, system, imageUrl }], failed: [{ id, error }] }` |
| `games.add` | `{ games: [spec] }` (1 to 60) | GM games for named GMs without accounts, straight onto the board (approved, fee approved, staff-made), each checked like a game staff list | `{ added: [{ title, id, seriesId, sessions, first, skipped: [{ start, when, reason }] }], failed: [{ title, error }] }` |

A `games.add` spec: `title`, `system`, `gm` (the name shown), `blurb`, `seats` (2 to 8), `offlinePlayers` (players
already in the group, 0 to seats), `gmFee` (cents: 0, 500 or 1000; default 500), `schedule` (`one-shot`, `weekly`,
`fortnightly` or `flexible`), `start` and `end` (ms: the first session), `tables` (ids), `imageUrl` (optional: a
`https://cdn.shopify.com/…` picture in the store's Shopify Files), `level`, `age`, `tags`, `characters`, `bring`.

- Checks: the game's details as for any game; the first session as a staff-made game (opening hours, free tables, no
  table an event locks, the shop tables allowed). A start between the hours (1:30pm) is allowed for these, and every
  later session of the series keeps it.
- Weekly and fortnightly games get their sessions to the booking horizon, and the daily top-up keeps going; a date
  whose tables aren't free (an event locks them, a booking has them) is skipped and listed in `skipped`.
- One game that can't go on is listed in `failed` with the reason; the rest still go on.
- Unknown kind: 422 `Unknown job: <kind>`.

## 3. Players already in a game (`offlinePlayers`)

- `games.offline_players` (migration: one `ALTER TABLE`): players a game's group already has who don't book through
  the Lair (Mo's GM list: "5/6" is five players in a six-seat game). They count as seats taken everywhere: `taken`,
  Full, what can be booked. They are never named.
- A series keeps the number in its details, so every session it plans has them.
- They count wherever free seats are worked out: booking a seat, staff adding players ("Only 1 seat left."), staff
  editing seats ("<when> already has 6 players…"), and the seats kept for a series' regulars.

## 4. Pictures by Shopify Files address

A game's `imageId` may be a `https://cdn.shopify.com/…` address (loaded games); `image` is then that address as it is.
Pictures uploaded through the Lair keep being served at `/img/<id>`.

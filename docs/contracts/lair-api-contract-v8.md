# Lair app API: round 8 (9 Oct 2026)

**Changes only.** On top of `lair-api-contract-v7.md` (v7.1) and everything before it; where they disagree, this file
wins. Money in cents, times in ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain
sentence." }` with a 4xx or 5xx.

**Where things live:** backend `r8-base` (b79aeb6 + this file) of dicegoblinnz/Dice-Goblin-Lair; theme `r8-base`
(bf2cf31) of dicegoblinnz/Dice-Goblin-website. Both already have round 8's two fixes (barcodes in any form; the pass
form's group list). Two builders, each owning one feature end to end (backend and theme):

| Section | Builder | Backend branch | Theme branch |
|---|---|---|---|
| 1 Weekly table holds | holds | `r8-holds-api` | `r8-holds` |
| 2 Friends on event sign-ups | guests | `r8-guests-api` | `r8-guests` |

Mo's words (6 Oct, 19:20):
> For the staff part make the session or event holding can have the option to hold weekly just like ttrpg sessions.
>
> For signing up for events always ask if they intend to get another person and have it as a thing to add another and
> another etc.etc. with either their code and if they don't have one state their name etc.

---

## 1. Weekly table holds [holds]

Staff hold tables for a session, a league or an event on the staff page (`POST /blocks`, the "Holds and openings" tab
and the floor's quick hold). A hold can now repeat weekly or fortnightly, the way TTRPG sessions do.

### Rules
- **A repeating hold is a hold series** plus ordinary `blocks` rows, one per date, each with `series_id`. Availability,
  the booking map, the floor and every check keep reading `blocks` exactly as today: nothing else learns about series.
- **The dates:** the first is the hold's own start; then every 7 (weekly) or 14 (fortnightly) days at the same Lair clock
  time and length (`time.at(addDays(firstDay, n * every), startMinutes)`, so daylight saving never moves it). A hold that
  crosses midnight keeps its length.
- **How far ahead:** holds exist up to `until` (the last day one can start on, inclusive), and never more than the
  booking horizon plus 7 days ahead (`rules.horizonDays + 7`). Maintenance tops up a series that hasn't reached its
  `until` (or has none) to that horizon, next to where it plans TTRPG sessions (`planSessions`).
- **Skipping a date:** removing one hold of a series puts its day on the series' `skip_days`, so maintenance never makes
  it again.
- **Stopping:** "this and every later date" removes those holds and ends the series the day before (`until_day`); from
  the series' first date to come, the series is stopped (`status: 'stopped'`).
- Holds in the past are never removed or changed by any of this.
- **Clashes:** like today, holding tables never moves a booking; the answer lists overlapping active bookings, now for
  every date made.

### Routes (staff)
- **`POST /blocks`** takes, as well as today's `{ tables, start, end, label, type, game }`:
  - `repeat`: `''` (or left out: a one-off, as today), `'weekly'` or `'fortnightly'`;
  - `until`: `'YYYY-MM-DD'` or null/empty (no end).
  - Answer: today's `{ block, clashes }`, where `block` is the first hold, plus `series: seriesView | null`. `clashes`
    become `[ { ref, start } ]` across all the dates made (one-off holds: the same shape).
  - 422 "Pick how often it repeats: weekly or fortnightly. Or leave it as a one-off."
  - 422 "'Repeat until' has to be a date on or after the first one."
- **`POST /blocks/:id/delete`** takes an optional body `{ later: true }`:
  - no `later`: removes that one hold (today's behaviour); for a series hold, its day goes on `skip_days`;
  - `later: true` on a series hold: removes it and every later hold of its series, and ends the series (see Stopping);
  - answer `{ ok: true, removed: <how many holds went> }`. An id that isn't there answers `{ ok: true, removed: 0 }`, as
    today, so a second tap isn't an error.

### Views
- **A block (staff floor `blocks`)** adds `seriesId` (or null), `repeat` (`'weekly'`, `'fortnightly'` or null),
  `repeatTag` (or null) and `until` (`'YYYY-MM-DD'` or null). The public floor's blocks add nothing (public labels only,
  as today).
- **`repeatTag`** reads like an event's (v7 section 17): "Weekly · Thursdays 6pm", "Fortnightly · Thursdays 6:30pm".
- **`seriesView`**: `{ id, label, type, game, tables, repeat, repeatTag, startTime ('18:00'), minutes, firstDay, until,
  skipDays, status: 'active' | 'stopped' | 'ended', next: [ { id, start, end } ] }` (up to 6 dates to come).

### Stored (migration: holds appends ONE entry to `MIGRATIONS`)
```sql
ALTER TABLE blocks ADD COLUMN series_id TEXT
CREATE INDEX IF NOT EXISTS blocks_series ON blocks (series_id, starts_at)
CREATE TABLE IF NOT EXISTS block_series (
  id TEXT PRIMARY KEY, tables TEXT NOT NULL, start_min INTEGER NOT NULL, minutes INTEGER NOT NULL, every_days INTEGER NOT NULL,
  first_day TEXT NOT NULL, until_day TEXT, skip_days TEXT, label TEXT, type TEXT, game TEXT, status TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)
```

### Theme (staff page)
- **"Holds and openings" tab, Hold tables form:** "Repeats" (Doesn't repeat / Weekly / Fortnightly) and, when it
  repeats, "Last date (optional)" with the hint "Leave it empty to keep holding every week." The answer's clashes show
  as today's heads-up, with their dates.
- **The holds list:** a series is one card: its label, type, tag, tables, the next dates (up to 4), each with **Skip
  this date**, and **Stop repeating** (asks first: "Stop holding T14–T21 every Thursday from Thu 15 Oct? Earlier dates
  stay.").
- **The floor:** a series hold's Remove asks "Just this date, or stop repeating?" The floor's quick "Hold these tables"
  stays a one-off.
- **Demo** (`assets/lair-demo.js`): `createBlock` with `repeat` and `until` (holds made up to the demo's horizon),
  `removeBlock(id, { later })`, the views above, the same messages. **LiveBackend** (`assets/lair-core.js`):
  `removeBlock(id, options)` sends `options` as the body (`createBlock` already sends what it's given).
- The staff page's words are Mo's tools: plain and short.

---

## 2. Friends on event sign-ups [guests]

### Rules
- **`POST /events/:occurrenceId/join`** takes `guests: [ { code?, name? } ]`, up to 5. Each guest is someone coming with
  the person signing up:
  - **`code`**: their member code (SJ-OWLBEAR-17; any case, dashes optional, as check-in reads codes): the Lair finds
    that member and keeps their customer id and the name the Lair has for them;
  - **`name`** (1 to 80 characters) for someone without a code;
  - both: the code wins.
- With `guests` sent, **`people` = 1 + the number of guests** (a `people` in the body is ignored). Without `guests`, it
  works exactly as today (1 to 6, friends unnamed), so an old page keeps working.
- Places, the entry fee (fee × people) and online payment work on `people`, as today.
- **Messages (422):**
  - "Add a name or a member code for each person coming, or take them off the list." (a guest with neither)
  - "Gobgob doesn't know the member code <CODE>. Check it, or put their name instead." (`<CODE>` as typed, in capitals)
  - "That's your own member code, friend. Add the people coming with you." (the person signing up, when logged in)
  - "<Name> is on the list twice." (the same member twice)
  - "Sign up between 1 and 6 people." (more than 5 guests)
- **Stamps** (the loyalty card, v6/v7): an attended sign-up gives the person who signed up a stamp for themselves and one
  for each guest without an account (as today), and **each guest with an account gets their own stamp** on their own
  card. `stampCount`, `stampedSessions`, the recent list and the member history all follow.
- **The guest's My Lair:** GET /me `joins` also lists sign-ups they're a guest on, with `guestOf: { name }` (the first
  name of whoever signed them up). They can't cancel or pay those: `canCancel: false`, and the cancel route answers 403
  "Only the person who signed up can change this. Ask them, or the counter." for a guest.
- **Check-in:** a member code scanned at check-in that has no booking of its own today but is a guest on today's
  sign-up shows that sign-up (as `guestOf`), so staff can mark it attended (for everyone on it, as today).
- **Emails:** the sign-up confirmation lists who's coming: "Coming: Sam Jones, Kiri Smith, a friend". Guests aren't
  emailed.

### Views
- `joinView` (the person's own sign-ups, the join answer) adds `guests: [ { name, member } ]` (member: they have an
  account; no codes or ids).
- `staffJoinView` adds `guests: [ { name, member, customerId, code } ]` (code: their member code, for staff).
- GET /me `joins` entries for a guest: `joinView` of the sign-up without its money (`amount`, `due`, `paidAmount` 0) and
  without the other guests' names, plus `guestOf` and `canCancel: false`.

### Stored (migration: guests appends ONE entry to `MIGRATIONS`; at the merge it goes after holds')
```sql
CREATE TABLE IF NOT EXISTS event_join_guests (
  id TEXT PRIMARY KEY, join_id TEXT NOT NULL, customer_id TEXT, name TEXT NOT NULL, code TEXT, created_at INTEGER NOT NULL)
CREATE INDEX IF NOT EXISTS event_join_guests_join ON event_join_guests (join_id)
CREATE INDEX IF NOT EXISTS event_join_guests_customer ON event_join_guests (customer_id)
```

### Theme
- **The sign-up form** (`assets/lair-calendar.js`, `[data-join-form]`): instead of the "How many?" chips, a **"Who's
  coming?"** part: "You" (their name, as now), then the question **"Bringing anyone?"** and an **"Add another person"**
  button. Each added person is a row with **Member code** (optional; hint "On their My Lair card, like SJ-OWLBEAR-17")
  and **Or their name**, and a remove button. "Add another person" works again and again up to the places left and 5 more
  people, then says why it stopped. The total and the places left follow the count. Errors from the app show by the
  form, as today. 44px targets, labels on every field, focus moves to a new row's first field and back after removing.
- **My Lair** (`assets/my-lair.js`): a sign-up lists who's coming ("You, Kiri Smith and a friend"); a sign-up they're a
  guest on shows in Bookings as "With Sam" without cancel or pay.
- **Staff page** (`assets/lair-staff.js`, the floor's and Today's sign-ups, and check-in): guests' names under the
  sign-up, members marked, with their code.
- **Demo** (`assets/lair-demo.js`): `joinEvent` with `guests` and the same messages (codes are the demo members' codes),
  the views above, guest stamps, `guestOf` entries.
- Customer words in Gobgob's voice (gobgob-voice), NZ English.

---

## 3. Merge rules (both builders touch the same files)
- **`src/lair.js`:** holds edits `createBlock`, `removeBlock`, `rowToBlock`, the floor's block views and maintenance (next
  to `planSessions`' call); guests edits `joinEvent`, `joinView`, `staffJoinView`, `confirmJoin`, GET /me's joins,
  `stampCount`, `stampedSessions`, check-in's member lookup and the cancel route for sign-ups. New helpers go next to the
  function that uses them. Each appends one `MIGRATIONS` entry at the end (the expected conflict: the coordinator keeps
  both, holds' first). Nothing may depend on an entry's number.
- **`src/core.js`:** a helper either needs goes next to related helpers (holds: next to `holdUntil`; guests: next to
  `codeKey`).
- **Tests:** new files only (`test/round8-holds.test.js`, `test/round8-guests.test.js`); edit `test/lair.test.js` only
  where an existing test changes on purpose, inside that test.
- **Live harness:** an HTTP flow each (`tools/qa/live/flow-r8-holds.mjs` right after `step flow-r7-a.mjs` in
  `run-all.sh`; `tools/qa/live/flow-r8-guests.mjs` right after `step flow-r7-b.mjs`).
- **README:** route rows next to the related rows; a "Round 8 (…) added…" note after the round 7 notes (holds after
  backend-a's round 7 note, guests after backend-b's).
- **Theme:** holds owns the staff page's holds region and the floor's hold actions in `assets/lair-staff.js`; guests owns
  `assets/lair-calendar.js`, the sign-up parts of `assets/my-lair.js` and the sign-up parts of `assets/lair-staff.js`
  (floor and Today's sign-ups, check-in's member card). `assets/lair-core.js` and `assets/lair-demo.js` are shared: edit
  only your own methods; new ones go right after the related existing method. CSS next to your feature's own block.

# Lair API contract v21-tables: a session's new tables for its later sessions too

27 Oct 2026. From Mo: "I want there to be an option for games when they change Thier table location they keep that
location for the future sessions, I noticed when I made a session on one table space it changed the next week I want it
to be able to keep that new space when changed".

Why it happened: Edit session (`POST /games/:id/edit`) moved one session only. A weekly or fortnightly game's later
sessions kept their own tables, and the sessions its series added later took the tables the game was listed on
(`series.tables`). So a game moved to another table went back to the old one the next week.

The code is in `src/lair.js` (`editGame`). Tests: `test/round21-tables.test.js`.

## `POST /games/:id/edit` (staff with GM games)

As before (contract v7, section 11), plus:

- `tablesScope`: `'series'` or `'session'`, read only with `tables`.
  - `'series'`: this session moves as before. Then every later session of its series that hasn't started takes the same
    tables, each at its own time, where they're free then (the same check as the move: GM rules, opening hours, locked
    event tables, bookings and holds, shop tables open to staff, no lead time or horizon; its own time, already
    accepted, isn't held to the whole hours). Nothing this call places can overlap on a table: a later session at the
    time this session moves to (or overlapping one moved before it) keeps its tables, with `The session you moved is
    on those tables then.` Its GM hold and every seat on it move with it (not cancelled seats, nor a GM's charge,
    which has no table). Unpaid seats follow the new room's price, as for this session. A session that can't take them
    keeps its tables and is listed in `kept`. The series takes the new tables too (`series.tables`), so the sessions it
    adds later get them, shop tables included (staff picked them: the series' `staffTables`, as for a series staff
    made); a date where they're taken is skipped and staff hear, as always ("Game series needs a table").
  - `'session'`, or no `tablesScope` (an older page): this session only, as before.
  - With `'series'`, `tables` can be the session's own: its later sessions then take them ("these tables from now on").
  - Anything else: 422 `Choose whether the new tables are for this session only or for every later session too.`
- Later sessions keep their own times: a new day or time moves this session only.
- A session keeping its time can change tables even when the time isn't on the hour (a game the owner loaded at 6:30pm):
  the whole-hour rule is for a new time.
- Nobody's emailed about new tables (as before: players hear about a new time only).

The answer gains `tables` when the request had `tables` on a session of a series:
`{ scope: 'series' | 'session', moved, kept: [{ id, start, when, tables, reason }] }`. `moved`: how many later
sessions took the new tables; `kept`: the ones that couldn't (`tables`: what they kept, `reason`: why, for example
`Table B3 is already taken at that time. Pick another.`).

## Elsewhere

- **A seat put back** (`POST /bookings/:id/update`, status from cancelled or a no-show to on) takes its session's tables,
  room and times as they are now, so it never holds the table the session left.
- **The staff view of a session** (the floor for staff, and the edit's answer) has `series.tables`: the tables the series
  gives the sessions it adds later. The public board doesn't.

## The staff page

Edit session on a session of a weekly, fortnightly or flexible game asks, under the map, "These tables for later
sessions too?" when the tables picked aren't this session's, the game's (`series.tables`) or a later session's:

- "This and every later session" is picked to start with only when staff change the tables of a session that has the
  game's usual tables. Otherwise (a session already set apart, like one that couldn't move) it starts on "Just this
  session". Staff's own pick always stands.
- A save that never changes the tables sends none: renaming a session set apart moves nothing.
- After saving, the message says how many later sessions moved (or that none could, or that they're on the tables
  already). Any that couldn't move are listed in a note on the game's page and the games list, each with its date, the
  tables it kept, why, and Manage (which opens it, even past Coming up's two weeks). Giving one its own table takes it
  off the note; Done puts the note away.

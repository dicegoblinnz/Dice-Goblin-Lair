# Lair API contract v22-holds: every hold can be edited

28 Oct 2026. From Mo, with a screenshot of the staff page's Current and upcoming holds: "I can't edit any of the
weeklies for the events and only the ones I made. Please make it so that all that have been created can be edited."

Why it happened: an event's tables are its Tables reserved in Shopify (the `lair_event` entry). The holds list showed
them as "From the events calendar" with nothing to tap, and only the Events tab could change them, for every date at
once. A hold staff made could be removed (a weekly one skipped or stopped) but never changed. The list also had a card
for every date of every weekly event.

**Changes only**, on top of everything before; where they disagree, this file wins. Times in ms (UTC), shown in Lair time
(Pacific/Auckland). Backend: `src/holds.js` (new), `src/core.js` (`eventHolds`), `src/lair.js` (routes, the floor, the
POS's today, `updateEvent`, maintenance). Tests: `test/round22-holds.test.js`. Theme: the staff page's Holds tab and
floor (`assets/lair-staff.js`), the Events tab (`assets/lair-staff-events.js`), `assets/lair-core.js`, the calendar's
note (`assets/lair-calendar.js`) and the demo (`assets/lair-demo.js`).

## 1. An event date's own tables

Stored: `event_hold_dates`, made when missing: `occurrence_id` (the key, `<handle>@YYYY-MM-DD`), `event_id` (the
handle), `tables` (a JSON list of table ids; `[]` holds none that date), `starts_at` and `ends_at` (the date's times
when it was changed, for tidying up), `by` (`staff:<customer id>`, or `staff`) and `updated_at`.

What it does (`eventHolds`, so everywhere: the floor, bookings, games and holds checked against locked tables, and the
POS's today):

- A date with its own tables holds them in place of the event's usual tables (Tables reserved), soft or locked as the
  event is, and its hold says `changed: true`. A date with `[]` holds no tables (no `ev-<occurrence id>` item).
- An event with no Tables reserved can still hold a date's own tables.
- Game tables don't change: they stay soft-reserved for the event, less any table the date's locked hold has (its
  usual tables or its own).
- A date keeps its own tables when the event changes (its times included). A date that goes from the calendar (skipped
  or deleted) holds nothing; if it comes back, its own tables come back with it.
- Maintenance forgets a date's own tables 31 days after the date ends.

### `POST /events/:occurrenceId/hold` (staff with Tables or Events)

- `{ tables }`: table ids, or tables written the Tables reserved way (`T10-T13, T18-T21`, a room's name, `all`). `[]`
  or `''`: no tables held that date. The event stays on the calendar either way.
- `{ usual: true }`: back to the event's usual tables.
- Tables the same as the usual ones are back to usual (nothing is kept for the date).
- Errors: `404 That event date could not be found.` (no such date on the calendar); `409 That date has finished, so its
  tables can't change.`; `422 Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all.`;
  `422 Send the tables to hold that date, or usual: true.`; `403` for anyone else, in the staff page's words.
- Holding never moves a booking. → `{ hold, clashes }`: `hold` is the date as `holdEvents` has it (section 3) plus
  `eventId` and `title`; `clashes` `[{ ref, start }]`: active bookings that overlap the date on the tables it holds,
  other than the event's own (its game tables), soonest first.

## 2. Every date of an event

`POST /events/:handle/update` (staff with Events, contract v7 section 10), as before. When Tables reserved changes,
dates with their own tables keep them, except any that are now the same as the new usual tables: those go back to
usual. The answer is as before; the staff floor's `holdEvents` says which dates kept their own.

## 3. The staff floor: `holdEvents`

The floor's staff view gains `holdEvents`: each event with tables held in the window (usual tables, or a date's own),
soonest date first:

```
{ eventId, title, repeat: 'weekly' | 'fortnightly' | 'monthly' | null, repeatTag: 'Weekly · Fridays 6pm' | null,
  usual: ['T10', …], usualText: 'T10-T13, T18-T21', locked: true, gameTables: 'T8+T9, T10+T11' | '',
  dates: [{ occurrenceId, start, end, tables: ['T18', …], changed: false, by?, at? }] }
```

`dates`: every date of the event in the window, in order. `changed`: it has its own tables (`[]`: none held that
date); `by` and `at` say who changed it and when. The public floor is unchanged: its `eventHolds` follow each date's
tables.

## 4. Editing a staff hold: `POST /blocks/:id/update` (staff with Tables)

Body: any of `tables` (ids, or written as the Hold tables form takes them), `start`, `end`, `label` (80 characters at
most; empty is `Held`), `type` (20 at most), `game` (40 at most; `''` clears it), and for a date of a weekly or
fortnightly hold `scope`: `'date'` or `'series'`.

- **A one-off:** what's sent changes. Its start and end can move to another day.
- **A date of a weekly hold, `scope: 'date'`:** this date only: its tables, start and end (still on its own day). It's
  marked as changed (`blocks.changed`), so a change to every date leaves it be. `label`, `type` and `game` belong to
  the whole hold and are left as they are. `{ scope: 'date', usual: true }` puts the date back to the hold's tables,
  times, label, type and game, and it's no longer changed.
- **`scope: 'series'`:** every date to come takes what's sent: the tables, the start's and end's Lair clock times (the
  hold keeps its weekday; `start` and `end` are read on the date sent), label, type and game. The hold series takes them
  too, so dates made later get them. A date that has started stays as it is, and dates changed one at a time keep their
  own: the answer lists them in `kept`.
- Errors: `404 That hold could not be found.`; `409 That hold has finished, so it can't change.`; `422 Choose whether
  the change is for this date only or every date to come.` (a weekly hold's date, no scope); `422 Pick tables that
  exist, like T11-T20.`; `422 The hold needs an end time after the start.`; `422 That would end the hold before now.
  Remove it instead.`; `422 A date of a weekly hold stays on its day. Skip it and hold the other day instead.`
- Holding never moves a booking. → `{ block, clashes, series, kept }`: `block` as the floor has it, `clashes` `[{ ref,
  start }]` across every hold it changed, `series` the hold series as staff see it (or `null`), `kept` `[{ id, start }]`.

The staff floor's holds gain `changed: true` for a date changed one at a time.

## 5. The staff page

**Holds and openings › Current and upcoming holds**, soonest first:

- **An event's tables** are one card: a repeating event's says its repeat tag and "From the events calendar", its usual
  tables and times (Locked when they are), its next four dates and "Then every Friday". Each date has **Change** (its
  tables, under it) and **Free the tables** (none held that date); a date with its own tables, or none, says so and has
  **Back to usual**. The card has **Change every date** (staff with Events: the usual tables and Lock these tables; the
  times are the event's, changed under Events) and **Stop holding tables** (asks first; the event stays on the
  calendar). A one-off event's card has its date's Change and Free the tables. An event's game tables are named, with
  Change them under Events.
- **A staff hold:** **Edit** (what for, type, tables, day, from and until) and Remove.
- **A weekly staff hold:** **Edit every date** (what for, type, tables, from and until), and each date **Change** (its
  tables, from and until) and Skip this date. A changed date says what it has, with **Back to usual**.
- Every edit opens in its card, says what the tables read as while typing, saves with **Save** or goes with **Cancel**,
  and its toast says what's held, with a heads-up for bookings that overlap. Focus stays in the card.

**The floor:** a table an event holds says From the events calendar, with **Free this table today** (that date's own
tables become its tables less this one) and **Change the hold** (the Holds tab, on that date). A staff hold's table
gets **Edit** too (the Holds tab, on that hold).

**The calendar:** an event date's note ("T10–T13 are held for card night") follows that date's tables.

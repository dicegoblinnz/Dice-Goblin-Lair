# Lair app API: the weekly numbers (24 Oct 2026)

**Changes only**, on top of v18-private and everything before it; where they disagree, this file wins. Times in ms (UTC),
shown in Lair time (Pacific/Auckland). Backend: `src/report.js` (the numbers, the steps, the Monday email), `src/lair.js`
(routes, maintenance, `bookings.added_by`) and `src/config.js` (`REPORT_EMAIL`). Theme: the step beacons in
`assets/lair-core.js` and the booking scripts, built on the theme's `website-lab` branch first. Tests:
`test/round19-report.test.js`.

From the website lab's brief ("Dice Goblin website lab: brief and handoff", 24 Oct 2026): engagement at Dice Goblin is
people coming to the Lair and coming back, and every change to the website is judged against it. Mo picked: count a visit
when it was checked in or paid ("Checked in or paid"), and build a staff-only weekly report plus an anonymous count of
bookings started and finished ("Yes, build both"). Nothing goes live without his yes.

## 1. Rules

### 1.1 A visit

- A table booking, walk-in or TTRPG seat that was checked in (`seated` or `done`) or paid (in full, in part, or by a
  session pass), or an event sign-up that was checked in (`attended`) or paid.
- Cancelled ones, no-shows and unpaid online holds never count.
- A visit belongs to the week its session starts in. Weeks run Monday to Sunday at the Lair, across daylight saving.
- Loyalty stamps alone would miss anyone staff took payment from without scanning, which is why "or paid" counts and the
  check-in rate shows beside the numbers.

### 1.2 Regulars (the one number)

- People with an account who had a visit in at least 2 different weeks of the 4 that end with the week shown.
- Each person counts for themselves: the booker, every named player with an account on a table or game seat, and every
  guest with an account on a sign-up. Friends without an account are in the visits, but can't be regulars.
- A GM running their own session isn't a visit unless they also book.

### 1.3 The other numbers, each week

| Number | What it counts |
| --- | --- |
| `visitors` | people with an account who had a visit |
| `visits` | everyone on the visits, friends without an account included |
| `checkIns` | `checkedIn`, `paidOnly` (paid, never scanned), `notRecorded` (neither, and not a no-show) and `rate` (checked in, as a % of the three; `null` with none) |
| `noShows` | bookings marked as a no-show |
| `bookingsMade` | bookings and sign-ups by the week they were made: `online`, `staff` (a walk-in, a staff-page booking, a seat staff added, a sign-up staff added) or `saved` (a weekly regular's seat Gobgob saved) |
| `newMembers` | people new to the Lair app (their first booking, sign-up or My Lair visit) |
| `ttrpg` | sessions that weren't cancelled: `sessions`, `seats` on offer, seats `taken` (booked seats plus players the GM brought, up to the seats) |
| `library` | `loansOut`: library games that went out |
| `steps` | the website's booking steps (1.4): `table`, `ttrpg`, `event`, each `{ start, login, done }` |

The report's `library.memberships` is the Lair library memberships that still borrow now (`active`, `cancelling`,
`ending`, `past_due`), not by week. Simplee members aren't in it.

### 1.4 Steps

- The website sends one when someone starts a booking (`start`), is asked to log in on the way (`login`, TTRPG seats
  only for now), and finishes it (`done`). Flows: `table`, `ttrpg` (a seat at a session), `event` (a sign-up or a game
  table at an event).
- Counted per day at the Lair. Nothing about who: no customer, browser or address is stored, and the route reads none of
  them (it runs before anyone is looked up).
- Anything else sent is ignored. One browser (by address, held in memory only) counts at most 30 steps in 10 minutes;
  more are dropped. The answer is always `{ ok: true, counted }`, so a page never waits on it or shows an error.
- Demo mode never sends them.

### 1.5 The Monday email

- From Monday 8am at the Lair (or the first maintenance run after, if the app missed Monday), once a week: last week
  next to the week before, with a button to the staff page.
- To `STAFF_EMAIL`, or to `REPORT_EMAIL` when that's an address; `REPORT_EMAIL` = `off` stops it.
- The first run after this goes live only notes the week. The first email is the first whole week of counting, the
  baseline every later week is compared with (staff bookings and steps are only counted from then).
- Under 80% of sessions checked in, it says the count may be short and asks staff to scan everyone.

## 2. Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /proxy/report?weeks=` | staff with Community, or the main account | `{ asOf, tz, words, weeks: [...], library: { memberships } }`. `weeks` whole weeks before this one (default 8, at most 26), newest first, after this week so far (`partial: true`). Each week: `week` (its Monday, `YYYY-MM-DD`), `label` ("19–25 Oct"), `partial`, `regulars`, `visitors`, `visits`, `checkIns`, `noShows`, `bookingsMade`, `newMembers`, `ttrpg`, `library`, `steps` (1.3) |
| `POST /proxy/steps` | anyone | `{ flow, step }` (1.4) → `{ ok: true, counted }` |

## 3. Data

- `step_counts (day, flow, step, n)`: one row per day, flow and step. Made when the Lair starts.
- `bookings.added_by`: who on the team made a booking for someone (`staff:<customer id>`, or `staff`); empty when it was
  made online. Set on walk-ins, staff-page bookings (`staffOverride`) and seats staff add. Made when the Lair starts.
  Older staff-added seats are still told apart by their "Added by staff" note; older staff-page table bookings count as
  online.
- Indexes `bookings_created` and `event_joins_created`, for the weeks things were made.
- `meta` key `weekly-report`: the Monday of the last week emailed.
- Config `REPORT_EMAIL` (optional): an address, or `off`.

## 4. Going live

1. The Lair app first (a push to `main` deploys it), with Mo's yes. The route for steps exists before any page sends them.
2. Then the theme's step beacons: built and checked on `website-lab` (demo mode sends nothing), copied to the preview
   (`dice-goblin-2-theme`) and checked on real data, then live (`r17-theme`), each with Mo's yes.
3. The Monday after the first whole week, the first email arrives.

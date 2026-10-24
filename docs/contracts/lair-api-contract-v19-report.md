# Lair app API: the weekly numbers (24 Oct 2026)

**Changes only**, on top of v18-private and everything before it; where they disagree, this file wins. Times in ms (UTC),
shown in Lair time (Pacific/Auckland). Backend: `src/report.js` (the numbers, the steps, the Monday email), `src/lair.js`
(routes, maintenance, `bookings.added_by`) and `src/config.js` (`REPORT_EMAIL`). Theme: the step beacons in
`assets/lair-core.js` and the booking scripts, built on the theme's `website-lab` branch first. Tests:
`test/round19-report.test.js`; browser checks: `tools/qa/round19/steps.mjs` (the theme's `website-lab` branch on the mock).

From the website lab's brief ("Dice Goblin website lab: brief and handoff", 24 Oct 2026): engagement at Dice Goblin is
people coming to the Lair and coming back, and every change to the website is judged against it. Mo picked: count a visit
when it was checked in or paid ("Checked in or paid"), and build a staff-only weekly report plus an anonymous count of
bookings started and finished ("Yes, build both"). Nothing goes live without his yes.

## 1. Rules

### 1.1 A visit

- A table booking, walk-in or TTRPG seat that was checked in (`seated` or `done`), or an event sign-up that was checked
  in (`attended`), or either of them **paid on the day**: still paid (in full or in part), and first paid between 12 hours
  before the session starts and 24 hours after it ends (the shop opens at 4pm on weekdays, so a Paid staff tick the next
  afternoon still counts; second review, 24 Oct).
- Cancelled ones, no-shows and unpaid online holds never count.
- A visit belongs to the week its session starts in. Weeks run Monday to Sunday at the Lair, across daylight saving.
- Loyalty stamps alone would miss anyone staff took payment from without scanning, which is why a payment counts and the
  check-in rate shows beside the numbers. It has to be on the day, because a seat nobody came to becomes owed and is paid
  at a later visit (round 15), and a sign-up paid online days ahead says nothing about who came (found in review, 24 Oct).
- When something was first paid is `paid_at` (3).

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
| `bookingsMade` | bookings and sign-ups by the week they were made: `online`, `staff` (a walk-in, a staff-page booking, a seat staff added, a sign-up staff added, an event walk-in staff checked in) or `saved` (a weekly regular's seat Gobgob saved) |
| `newMembers` | people new to the Lair app, by when they first used it themselves (`first_seen`); a row staff made for someone counts in the week that person first turns up |
| `ttrpg` | sessions that ran (not cancelled or waiting for approval): `sessions`, `seats` on offer, seats `taken` (booked seats plus players the GM brought, up to the seats) |
| `library` | `loansOut`: library games that went out |
| `steps` | the website's booking steps (1.4): `table`, `ttrpg`, `event`, each `{ start, login, done, 'login-done' }` |

The report's `library.memberships` is the library members now, as `currentMembership` counts them (active, waiting on a
payment, or cancelled but inside the month they paid for), each person once; not by week. Simplee members aren't in it.

### 1.4 Steps

- The website sends `start` when a booking form opens, `login` when it opens for someone logged out (TTRPG seats ask
  them to log in first; tables and event sign-ups don't ask, so they never send it), `done` when the booking's made, and
  `login-done` with a done whose try had a login. `login` minus `login-done` is who gave up after being asked to log in.
  Flows: `table`, `ttrpg` (a seat at a session), `event` (a sign-up or a game table at an event).
- A start or a login counts once a try. A try lasts 30 minutes in that browser tab (2 hours once it has asked them to log
  in, since an emailed code can take a while), or until its booking's done, so coming back from logging in or picking
  another table isn't a second start, and an abandoned try doesn't hide the next one. The tab keeps only that a try is
  open and when it began. To see the log-in's own effect, compare `login-done` ÷ `login` with (`done` − `login-done`) ÷
  (`start` − `login`).
- Counted per day at the Lair. Nothing about who: no customer, browser or address is stored, the route reads none of
  them (it runs before anyone is looked up), and the page sends steps without the shop's cookies, so the app proxy can't
  add who's logged in to the request either.
- Anything else sent is ignored. One browser (by address, held in memory only) counts at most 30 steps in 10 minutes;
  more are dropped. The answer is always `{ ok: true, counted }`, so a page never waits on it or shows an error.
- Demo mode never sends them.

### 1.5 The Monday email

- From Monday 8am at the Lair (or the first maintenance run after, if the app missed Monday), once a week: last week
  next to the week before, with a button to the staff page.
- To `STAFF_EMAIL`, or to `REPORT_EMAIL` when that's one email address; `REPORT_EMAIL` = `off` stops it. Anything else
  there (a typo, two addresses) sends nothing and says so in the maintenance result, rather than going to `STAFF_EMAIL`.
- The first run after this goes live only notes a week: this week, or last week when it's a Monday from 8am. So the first
  email is the first whole week of counting, the baseline every later week is compared with (staff bookings and steps
  are only counted from then).
- The email is made before the week is noted as sent, so a failure leaves it to the next run.
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
- `bookings.paid_at` and `event_joins.paid_at`: when it was first paid, in full or in part; `members.first_seen`: when
  someone first used the app themselves (their first `last_seen`). The Lair's one write path (`write`) stamps them after
  every write to those tables (`stampWrites`, which can never fail the write), so every way of paying or turning up is
  covered (Shopify orders, the tab, cash, passes, staff ticking it paid, My Lair, bookings), and later changes never move
  them. Partial indexes hold only rows not yet stamped, so it costs lookups in nearly empty indexes (1,000 writes on
  20,000 bookings: 44 ms in review). On every start, rows from before get their first Shopify payment's time
  (`payments.at`), else their last change, and members their row's creation. Unticking Paid leaves `paid_at`, but a visit
  also needs it still paid.
- Indexes `bookings_created` and `event_joins_created`, for the weeks things were made.
- `meta` key `weekly-report`: the Monday of the last week emailed.
- Config `REPORT_EMAIL` (optional): an address, or `off`.

## 4. Going live

1. The Lair app first (a push to `main` deploys it), with Mo's yes. The route for steps exists before any page sends them.
2. Then the theme's step beacons: built and checked on `website-lab` (demo mode sends nothing), copied to the preview
   (`dice-goblin-2-theme`) and checked on real data, then live (`r17-theme`), each with Mo's yes. Copy only the step
   files (`lair-core.js`, `lair-play.js`, `lair-booking.js`, `lair-join.js`, `lair-calendar.js`), never the lab's
   `config/settings_data.json`. On the preview, check a step answers `counted: true` with the cookies left off.
3. The Monday after the first whole week, the first email arrives.

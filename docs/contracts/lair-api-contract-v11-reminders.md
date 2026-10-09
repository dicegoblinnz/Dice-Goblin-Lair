# Lair app API: round 11, reminders (9 Oct 2026)

**Changes only**, on top of `lair-api-contract-v9-play.md` and everything before it. Money in cents, times in ms (UTC),
days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Builder: reminders (backend `r11-r-api`, theme `r11-r`). Mo (9 Oct 2026, 7pm), on Oddity Alley: "Entry is free, so have
a add to calendar option on it and possibly a reminder the day prior if they opt for it?" On Blood on the Clocktower:
"Maximum capacity of 40 people but if we went more let it notify us so we cns try to organize a new group to
accommodate." On the card-game nights: "only ask people to register their interest and let the counter go up by how
many people plan on coming" (round 9's "I'm coming" and "Maybe", unchanged).

The code: `src/reminders.js` (mixed into the Lair like `src/interest.js`), small hooks in `src/interest.js`, the router
and the maintenance run in `src/lair.js`, `links` in `src/email.js`, the event's price note in `src/shopify.js`, and the
public `/ics/` route in `src/index.js`.

---

## 1. "Remind me the day before"

### Rules
- **Who:** anyone who says "I'm coming" or "Maybe" to an event date (round 9's `interests`, kind `event`, level `coming`
  or `maybe`). Not a TTRPG session's "I'm interested", not a waitlist place, not a sign-up.
- **Opt in:** off unless they ask. On `POST /interest` with `remind: true`, or later on the row with
  `POST /interest/:id/remind` (nothing else changes and nothing is sent again). `remind` left out keeps what it was.
- **When it goes (the rule):** the 10-minute maintenance run sends each one **once**, and only between **9am and 9pm**
  Lair time:
  - on **the day before** the date (from the first run after 9am that day);
  - or, if they turned it on **after the day before's window** (after 9pm the day before, or overnight), or the day
    before's runs missed it, **that morning** from 9am, as long as the date hasn't started ("Today: …");
  - turned on **on the day itself** (after midnight): no reminder (it's today);
  - nothing after 9pm or before 9am, ever. A date that has started, or is gone from the calendar (a skipped date, a
    deleted event), gets none.
- **Never twice:** the row is marked (`reminded_at`) before the email goes. Taking it back and saying it again on the
  same date keeps that it went. If Resend is down or busy (5xx or 429) the mark comes off so the next run (still in
  the window) tries again; anything else (an address Resend refused) isn't tried again.
- **A two-day event's dates are separate dates** (Saturday and Sunday, each `handle@YYYY-MM-DD`): each is its own
  interest and its own reminder.
- **At most 100 a run** (one batch to Resend); any more go 10 minutes later.

### The email (Gobgob signs it)
- Subject: `Tomorrow: <title>, <start, like 10am>` (or `Today: …` for the morning-of case).
- Title: "See you tomorrow!" (coming) or "Tomorrow’s the day" (maybe); "today" for the morning-of case.
- Intro: "Kia ora <first name>, here’s the reminder you asked for: <title> is tomorrow, <Saturday 21 November>, <10am to
  4pm>." then "You said you’re coming, so Gobgob’s expecting you." or "You said maybe. No pressure, friend: come along
  if you can."
- Details: Event; When; **Where** ("Dice Goblin, <the store address from Shopify>" then "Upstairs in Royal Oak Mall,
  above Whitcoulls. The lift is next to Whitcoulls.", plus " On weekends the lift runs during mall hours, 10am to 5pm."
  on a Saturday or Sunday); **Entry**, the price as the event says it (the entry fee "$10 a person, paid at the
  counter" (or "paid online when you sign up" / "online or at the counter" for a date with sign-ups paid that way), then
  the price note; or the price note as written, like "Entry: a booster pack"; or "Free entry" for a $0 fee; left out
  when the event says nothing); You said ("I’m coming" or "Maybe").
- Button: **Add to calendar** → `GET /ics/<date id>.ics` on the Lair app's own address (section 3). Links under it:
  **Google Calendar** (a pre-filled Google Calendar event) and **The event’s page** (`/pages/events-calendar#event=<id>`;
  a guest's carries `?interest=<id>&key=<key>&date=<date id>&said=<level>` so that page can take it back or change the
  reminder from any device).
- Outro: for a date with sign-ups, "It takes sign-ups, so sign up on the event’s page to keep your place." (or, when
  it's full, "It takes sign-ups and it’s full right now. Join the waitlist on the event’s page, and the team will be in
  touch if a place opens up."). Then how to take it back: a member "Not coming after all? Take it back on the event’s
  page or in My Lair, so the numbers stay right."; a guest "Not coming after all? Take it back on the event’s page (the
  link above), so the numbers stay right."

### Routes
- **`POST /interest`** (round 9) also takes **`remind: true | false`** for an event date's `coming` or `maybe` (ignored
  for a session or a waitlist place). Its `interest` (everywhere an interest is answered, `GET /me`'s `interests` too)
  now carries **`remind`** (boolean), **`reminded`** (boolean: it went) and **`people`** (a waitlist place's, else null).
- **`POST /interest/:id/remind`** `{ remind: true | false, key? }` (the member it belongs to, staff, or a guest with the
  key from their answer) → `{ ok, interest }`. Turning it on again while it's on keeps when it was turned on. Errors:
  - 404 "That could not be found. It may have been taken back already." (unknown, or taken back)
  - 403 "That isn't yours to change."
  - 422 "Reminders are for “I’m coming” and “Maybe” on an event date." (a session's interest or a waitlist place)
  - 422 "Say whether you want the reminder: on or off." (`remind` not a boolean)
- **`POST /internal/reminders`** `{ at? }` (the Worker itself only: `X-Lair-Internal`, never through the store) runs
  this rule at `at` (ms; now when left out) and waits for the send → `{ sent, dates, ok }`. The cron's maintenance runs
  it at the real time (`connection.reminders` in the status table when any went). The live checks reach it through the
  dev entry's `POST /__dev/reminders` (tools/qa/live/dev only, never deployed).

---

## 2. The waitlist for a full date

### Rules
- **Where:** an event date **with sign-ups** (a capacity) that can't fit them: it's full, or has fewer places left
  than they're asking for. The theme offers it where the sign-up form would say "This date is full."
- **What it is:** an interest with level **`waitlist`** and **`people`** (1 to 6). **Never a sign-up and never
  counted in places taken** (`eventJoins`, the capacity check and check-in don't see it). One per person per date
  (their account or their email, as round 9): a "Maybe" they had on that date becomes the waitlist place (its reminder
  goes off); asking again changes the people or the note and emails nobody.
- **Who:** anyone. A member's name and email come from their account, and their saved mobile fills in when they leave
  it out; a guest gives a name, an email and a mobile. A mobile is required for everyone (the team rings them).
- **Each new waitlist place emails the staff** (`STAFF_EMAIL`, replies go to the person) **and the person**.
- **The public sees counts only:** `waiting` (people) on `GET /floor`'s `eventInterest[<date id>]` and in `counts`,
  there only when anyone's waiting. The theme shows "Full · 3 waiting". Staff get the names, emails, mobiles, people
  and notes in `GET /floor`'s `interests` (as round 9), shown under "Waitlists" on Today's bookings.
- **Taking it back:** `POST /interest/:id/remove` (round 9), as for a Maybe.
- **A place freeing up books nobody:** staff decide who gets it.

### Route
- **`POST /interest`** `{ waitlist: true, kind?: 'event', id, people?, name?, email?, phone?, note? }` (anyone) →
  `{ interest, counts, already, emailed, staffEmailed, placesLeft }`. `people` is 1 when left out. `interest.key` for a
  guest, as round 9. `emailed`: the person's email went; `staffEmailed`: the staff's. Errors, word for word:
  - 422 "The waitlist is for event dates." (`kind` given and not `event`)
  - 404 "That event date could not be found."
  - 422 "That one has already finished."
  - 422 "This one doesn't take sign-ups, so there's no waitlist. Just turn up!"
  - 422 "Join the waitlist for 1 to 6 people."
  - 422 "Keep the note to 280 characters."
  - 422 "Add your name." / "Add your email so we can get back to you."
  - 422 "Add a mobile number so we can reach you on the day." / "That mobile number doesn't look right. Try one like
    021 123 4567." (v7's mobile check, for everyone here)
  - 429 "Too many bookings in a short time. Call us and we will sort it out." (the soft limit)
  - 409 "You’re already signed up for this one. It’s in My Lair."
  - 409 "There’s still room for 2 people, so sign up instead." ("for 1 person" when one place is left)

### The emails
- **Staff** (plain, signed "Gobgob, keeping an eye on the Lair", button "Open the staff page"):
  - Subject: `Waitlist: <title>, <Sun 18 Oct> (<n> waiting)` (n: people waiting, this one included).
  - "Blood on the Clocktower on Sunday 18 October is full (40 of 40 places). Ruby Tane just joined the waitlist for 2
    people." (not full: "has 1 place left (39 of 40 taken), not enough for them.") then "5 people are waiting now. This
    is the moment to organise another group, if you can."
  - Details: Event, When, Places (`40 of 40 taken`), Name, Email, Mobile, People, Their note, Waiting (`5 people (3
    names on the list)`).
  - "Nothing is booked for them. If a place frees up, nothing happens by itself: who gets it is your call. Reply to this
    email to reach them."
- **The person** (Gobgob):
  - Subject: `You’re on the waitlist: <title>, <Sun 18 Oct>`; title "You’re on the waitlist".
  - "Kia ora Ruby, Blood on the Clocktower on Sunday 18 October is full, so Gobgob has put you on the waitlist for 2
    people." ("doesn’t have room for 4 right now" when it isn't full) then "Nothing is booked and nothing is paid. If a
    place opens up, or the team can start another group, they’ll be in touch."
  - Details: Event, When, People, Your note. Button "See the event" (a guest's link carries their key, as above).
  - "Changed your mind? Take yourself off the waitlist on the event’s page or in My Lair." (a guest: "… on the event’s
    page (the button above).")

---

## 3. An event date as a calendar file

- **`GET /ics/<date id>.ics`** on the Lair app's own address (`PUBLIC_URL`; public, like `/img/`): the date as an
  `.ics` file (`text/calendar`, `Content-Disposition: attachment; filename="<title>-<date>.ics"`, cached 5 minutes):
  the same entry the events page's Add to calendar makes (UID `<handle>-<YYYY-MM-DD>@dicegoblin.nz`, so adding it twice
  updates it), with the price line and the event's page in its description and the shop as its location. 404 (plain
  text) "That event date could not be found." for a date that isn't on the calendar.

---

## Storage

One migration entry (appended to `MIGRATIONS`; tests find it by its content): new columns on `interests` and an index.
- `remind` INTEGER (1: they want the reminder), `remind_at` (when they last turned it on), `reminded_at` (when it went).
- `people` INTEGER: a waitlist place's people; null on every other row.
- `CREATE INDEX interests_remind ON interests (remind, reminded_at, starts_at)`.

The Lair's rules now carry each event's `priceNote` (`price_note`) and `freeEntry` (an `entry_fee` of 0), read with the
events as before, for the email's price line.

## Cron work

The 10-minute maintenance run (`checkConnection`) adds the reminders (section 1) after the monthly bills.

## Staff routes

None new. Staff see waitlist places in `GET /floor`'s `interests` (the floor's staff view, as round 9: Check-in,
Tables, GM games or Events). Staff can change anyone's reminder (`POST /interest/:id/remind`) and take anyone's place
back (round 9's remove), as the floor's staff.

## Contract notes (choices made here)
- The reminder window is 9am to 9pm; a late opt-in goes the next morning, an opt-in on the day itself gets none. The
  theme hides the toggle on a date that's today.
- `waiting` is left out of counts when nobody is waiting, so round 9's answers keep their shape.
- The waitlist takes people when the date can't fit them (full, or not enough places), not only when it's full; the
  theme offers it on full dates only.
- Add to calendar in the email is a calendar file served by the Worker (`/ics/`), because email apps can't open the
  events page's `data:` files, plus a Google Calendar link.

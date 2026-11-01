# Lair app API: round 29, roleplayers phase 1, section 2: reminders (2 Nov 2026)

**Section 2 of v29** (the roleplayers plan's item 1, "Reminders"; the rest of v29 is in its own file). **Changes only**,
on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time (Pacific/Auckland). Errors
stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Mo approved it on 2 Nov 2026, with mockup D1 ("warm first"): an email two days before each one-off booking, so people
come, or let the place go while someone else can still have it. The plan Mo approved says "One tap cancels while it's
still free", so its cancel link works without logging in, for members and guests (2.6).

The code: `src/booking-reminders.js` (mixed into the Lair like `src/reminders.js`), the person's own cancel shared by
My Lair and the link (`cancelOwnBooking` and `cancelOwnJoin` in `src/lair.js`), the router and the 10-minute run in
`src/lair.js`, `POST /internal/reminders` in `src/reminders.js`, the setting in `src/core.js` (`rulesFromSettings`),
the Monday lines in `src/report.js` and the public `/ics/b/` route in `src/index.js`. Theme: `assets/lair-cancel-link.js`,
`snippets/cancel-link-early.liquid`, `sections/my-lair.liquid`, `layout/theme.liquid`, `config/settings_schema.json`,
`locales/en.default.json` (`lair.cancel_link`). Checks: `test/round29-reminders.test.js`, and in the browser
`tools/qa/round29-roleplayers/reminder-cancel.mjs`.

---

## 2.1 Who gets one

- A **confirmed one-off TTRPG seat**: kind `gm-seat` with no `series_id` (a weekly regular's saved seat has one, and
  gets none; a one-off seat at a weekly game gets one), on a session that's live (`open`, full or not).
- A **confirmed table booking**: kind `table`. One at an event (a game table, `occurrence_id`) only while its date is on
  the calendar.
- A **confirmed event sign-up** whose date is still on the calendar.
- Each needs an email. **Never:** a walk-in, a held booking, a cancelled one, a GM's charge for a player's seat
  (`gm-cover`), the GM's own booking (`gm`), or a seat on a session that's cancelled or waiting for approval
  (`pending`). One email per booking or sign-up, to the email on it (a party's other players aren't emailed).

## 2.2 When

- On the **Lair day two days before the day it starts** (a Sunday session: Friday), from **9am**, never at or after
  **9pm** (the round 11 window), **once**.
- Only for what was **booked before that day began** (Lair time). Anything booked on the reminder day or later had its
  confirmation just now, and gets nothing more.
- **Catch-up:** if none went on the reminder day (Resend down all day), it can go **the next day**, 9am to 9pm, while it
  can still be **cancelled free** online (before its deadline, 2.4) or has **nothing to pay**. **Never on the day
  itself.** Only for a reminder day these reminders were running on before 9pm (`meta` `booking-reminders-from`, their
  first start), so going live doesn't send everything booked for tomorrow.
- **A booking that moves** to another time or day gets its reminder again, for the new time (`reminded_start` is the
  start it went for; a sign-up goes by its date's start as the calendar has it now).
- **Daylight saving:** the day and the 9am are Lair time. A game on Sunday 4 April 2027 (the clocks go back at 3am)
  is reminded at 9am Friday NZDT; one on Sunday 26 September 2027 (they go forward) at 9am Friday NZST.
- **Never twice:** a row is marked (`reminded_at`, `reminded_start`) before its email goes. Resend down or busy (5xx or
  429): the mark comes off, so the next run tries again (still in the window). Anything else (an address Resend refused)
  isn't tried again. At most 100 a run (one batch); any more go in the next run, 10 minutes later.
- **The switch:** Theme settings › Lair bookings › Reminders › "Email a reminder two days before each booking"
  (`lair_booking_reminders`, a checkbox, unticked by default). Info: "One-off TTRPG seats, table bookings and event
  sign-ups. Saved weekly seats don't get one." `rules.bookingReminders` is true only when the **live** theme's settings
  (`config/settings_data.json` › `current`) say `true`: absent (a Lair deployed before its theme) or false sends none,
  so the Lair never sends a cancel link to a page without the cancel card. The website lab's settings have it true.
- None go while the Lair has only its built-in rules (Shopify unread): a later run, or the catch-up, sends them.

### The 10-minute run, and `POST /internal/reminders`
- The maintenance run sends them (`result.bookingReminders`: `{ sent, seats, tables, signUps }` when any went).
- `POST /internal/reminders { at? }` (the Worker itself only, the live checks' clock) runs them at a fixed time with the
  round 11 reminders. Its answer is unchanged for those (`{ sent, dates, ok? }`, with `{ sent: 0, dates: [] }` when
  none were due); booking reminders answer under **`bookings`** (`{ sent, seats, tables, signUps, ok }`), only when some
  were due.

### New columns (made sure of on every start, as round 15's are)
- `bookings` and `event_joins`: `reminded_at` (when it was claimed; null again if Resend was down), `reminded_start`
  (the start it went for), `cancel_key` (32 hex characters, `crypto.randomUUID()` without dashes, made when its first
  reminder is claimed, in the same step, and kept: a moved booking or a retry keeps its key).
- Indexes `bookings_reminded`, `event_joins_reminded` (only rows with a reminder).

## 2.3 The email, word for word (D1 "warm first"; Gobgob signs it; NZ English)

`<day>` is the start's weekday ("Sunday"), `<clock>` its time ("6pm", "6:30pm", "midday"), `<until>` the free-cancel
deadline in Lair time ("6pm Saturday", 2.4), `<$>` an amount ("$15", "$12.50").

- **Subject:** `See you <day> at <clock>?` ("See you Sunday at 6pm?")
- **Preheader:** `<saved> Cancel free until <until>.` while it's free to cancel with a deadline; otherwise
  `<saved> <When>.` ("Your seat at Monster of the Week is saved. Sunday 8 November, 6pm to 10pm.")
- **Title:** `See you <day>, <first name>?` (the first word of the name on the booking), or `See you <day>?` with none.
- **Intro** (`<saved>`, then for a seat who's counting on them):
  - seat: "Your seat at Candlekeep Mysteries is saved." / a party: "Your 2 seats at Candlekeep Mysteries are saved."
    then "Your GM and 3 players are counting on you." (the other people with seats at that session, the GM's offline
    players included), "Your GM and 1 player are counting on you.", or "Your GM is counting on you."
  - table: "Your table for 4 is saved." / at an event: "Your table for 2 at Warhammer night is saved."
  - sign-up: "Your place at Oddity Alley is saved." / "Your 3 places at Blood on the Clocktower are saved."
- **Details**, as the confirmation has them for that kind:
  - When: "Sunday 8 November, 6pm to 10pm"
  - seat: Game "Candlekeep Mysteries, D&D 5e" (a game named for its system says it once); Players (a party's names)
  - table: Event (at an event); Table "T3" / Tables "T14, T15"
  - sign-up: Event "Oddity Alley"; Coming (more than one: "Ria Moana, 2 friends")
  - Where: the round 11 words: "Dice Goblin, <store address>" then "Upstairs in Royal Oak Mall, above Whitcoulls. The
    lift is next to Whitcoulls." and, on a Saturday or Sunday, "On weekends the lift runs during mall hours, 10am to 5pm."
  - On your tab (a member's) or To pay (a guest's, who has no tab): "$15, paid at the counter on the day" / a seat the
    GM pays for: "Nothing: your GM's paying for your seat" ("seats") / nothing: a member's "Nothing to pay", a guest's
    "Nothing" / paid: "$15, paid already. Thank you!" / paid online before round 15: "$15, paid online. Thank you!" /
    part paid: "$5 left to pay at the counter on the day ($15 of $20 paid)". A sign-up with nothing to pay says what its
    event says instead: Entry "Free entry", or its price note ("A booster pack…").
  - Loyalty card: the loyalty card round's `cardLine(customerId, rules)` (a member's; left out without it).
- **Button:** "Add to my calendar": a seat or table `GET /ics/b/<booking id>.ics` (2.5), a sign-up its event date's
  round 11 file `GET /ics/<date id>.ics`.
- **Links:** "Google Calendar" · "See it in My Lair" (members only: `/pages/my-lair?view=ml-st-<code>`, tables
  `ml-bk-<code>`, sign-ups `ml-ej-<code>`, the ticket ids in `assets/my-lair.js`) · "Cancel my seat" ("Cancel my seats",
  "Cancel my table", "Cancel my sign-up"): `/pages/my-lair#cancel=<code>&key=<key>` (2.6), for members and guests,
  only while the rules let it be cancelled online now. Google Calendar for a seat or table: the title (2.5), times,
  "See it in My Lair: https://www.dicegoblin.nz/pages/my-lair" and the place; for a sign-up, round 11's.
- **Outro** (what cancelling means, from `cancelRule`; `<back>` is "your seat goes back on the board for someone else"
  / "your seats go back on the board for someone else" / "your table goes back for someone else" / "your place goes to
  someone else" / "your places go to someone else"):
  - free until a deadline, a member: "Can't make it? Cancel free until `<until>` and `<back>`. After that, the `<$ due>`
    stays on your tab."
  - free until a deadline, a guest: "Can't make it? Cancel free until `<until>` and `<back>`. After that it's yours to
    pay, even if you can't come."
  - a seat the GM pays for: "Can't make it? Cancel free until `<until>` and `<back>`. After that, if you can't come, the
    full `<$ the seat's price>` goes on your tab." (a guest: "… the full `<$>` is yours to pay.")
  - paid already (at the counter): "Can't make it? Cancel free until `<until>` and `<back>`, and you'll get your `<$>`
    back. After that it stays paid, even if you can't come."
  - waived (nothing due, but it still locks, so it keeps its deadline): "Can't make it? Cancel free until `<until>` and
    `<back>`."
  - nothing to pay, or nothing locks (a free seat or event, one booked before round 15, an event date that's gone),
    members and guests alike, since the cancel link is right there: "Can't make it? Cancel any time before it starts
    and `<back>`." ("Can't make it? Cancel any time before it starts and your seat goes back on the board for someone
    else.", "… and your table goes back for someone else.", "… and your place goes to someone else.")
  - already locked when it goes (never with the 24-hour cut-off, which is at least 27 hours after a reminder; only a
    longer one could): `TAB_WORDS.lockedNow` (a member) or `lockedNowGuest`; a seat the GM pays for,
    `GM_COVER_WORDS.seatLocked`. No cancel link.
  - paid online before round 15: its confirmation's words (`ONLINE_WORDS` in `src/core.js`): an event's game table or
    sign-up "You paid online, so you're locked in. Can't make it after all? Cancel in My Lair and have a chat with us
    about a refund."; anything else "Need to cancel? Do it in My Lair or call us at least 24 hours before, and you'll
    get your money back. After that the fee can't be refunded."
- **Sign-off:** "See you at the Lair!" / "Gobgob, the Dice Goblin" (the layout's own).

## 2.4 The deadline

`cancelRule` (round 15) decides it, as the confirmations do: something with a price booked from round 15's start locks
`refundHours` (24) before it starts. `<until>` is that moment in Lair time, "<clock> <weekday>". Across a daylight
saving change it's 24 real hours, so the clock moves: a 6pm Sunday 4 April 2027 game is free to cancel until **7pm
Saturday**, and one on 26 September 2027 until **5pm Saturday**, as the lock itself enforces.

## 2.5 `GET /ics/b/<booking id>.ics` (public)

- On the Lair app's own address (`PUBLIC_URL`), routed like `/ics/<id>.ics`: `src/index.js` matches
  `/ics/b/bk_<8 to 40 letters or digits>.ics` and asks the Lair's internal `GET /internal/bookingics/<id>`.
- The booking's own random id (`bk_` and 64 random bits) is the proof; a booking code never finds it.
- A calendar file (`text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="dice-goblin-<title>.ics"`,
  `Cache-Control: private, no-cache`) with one `VEVENT`: `UID:<booking id>@dicegoblin.nz` (one per booking, so adding
  it again updates it), `DTSTART`/`DTEND` (UTC, the booking's times now, so a moved booking's file has its new time),
  `SUMMARY` ("Candlekeep Mysteries at Dice Goblin", "Table for 4 at Dice Goblin", "Warhammer night at Dice Goblin"),
  `LOCATION` ("Dice Goblin, <store address>"), `DESCRIPTION` "See it in My Lair: https://www.dicegoblin.nz/pages/my-lair"
  and `URL` (the plain My Lair page). **Never** a name, email, phone or booking code.
- **404** `That booking could not be found.` (plain text) for an unknown id, a cancelled or no-show booking, a weekly
  saved seat, a walk-in, the GM's own booking, a GM's charge, a seat on a session that isn't live, or a table at an event
  date that's gone.

## 2.6 The cancel link: one tap, no login

The email's link is `/pages/my-lair#cancel=<code>&key=<key>` (the booking's or sign-up's code, like `RM-OWLBEAR-17`,
and its `cancel_key`). They ride in the fragment, which browsers never send to a server, so the key is in no server's
logs, Shopify's included. Both routes are public, through the store's app proxy (`/apps/liar/cancel-links/…`), with the
code and key in the JSON body, never an address. Nobody is looked up: logged in or not, they work the same. The key
only ever cancels.

### `POST /cancel-links/view { ref, key }`
→ `{ link: { kind, title, when, people, cancellable, until, reason } }` and nothing else:
- `kind`: `seat`, `table` or `signup`; `title`: the game or event ("Candlekeep Mysteries"), `null` for a plain table;
  `when`: "Sunday 8 November, 6pm"; `people`: how many it's for.
- `cancellable`: true while it can be cancelled online now; `until`: the free-cancel deadline ("6pm Saturday") while
  there is one, else `null` (nothing to pay, nothing locks: cancel any time before it starts).
- `reason` (when it can't): "That's cancelled already." / `TAB_WORDS.started` ("That one has already started, so it
  can't be cancelled online. Have a chat with us if something's not right.", also once it's checked in or marked a
  no-show) / `TAB_WORDS.locked(24)` / for a seat the GM pays for, `GM_COVER_WORDS.seatLocked(24)`.

### `POST /cancel-links/cancel { ref, key }`
- Cancels it by **the person's own path in My Lair** (`cancelOwnBooking` for a seat or table, `cancelOwnJoin` for a
  sign-up), never a second copy: the same rules and side effects (the seat back on the board, the GM's "Seat dropped"
  email, a GM's charge for the seat stopped, a library game let go, places freed, the refund rules, staff's "Refund due"
  or "Refund?" emails).
- → `{ ok: true, kind, people, refund: { due: true, amount } | null, notice }` (`notice`: the existing words for one
  paid online, like "Your spot is cancelled. You paid online, so have a chat with us about a refund.").
- **409**, nothing changed: "That's cancelled already.", `TAB_WORDS.started`, `TAB_WORDS.locked(24)`,
  `GM_COVER_WORDS.seatLocked(24)`.

### Both routes
- **404** "That cancel link doesn't work. Check you have the whole link from your email." for a wrong key, another
  booking's key, a code that isn't a reminded seat, table or sign-up (or a weekly seat), or either left out: one
  message, never saying which part was wrong. Keys are compared in constant time (`safeEqual`), against a stand-in
  when there's nothing to compare with.
- **429** "Too many tries. Wait a few minutes and try again, or give us a call." after 10 wrong tries from one address
  (`X-Lair-Client`) in 10 minutes, the right key too until then.

### The website (`assets/lair-cancel-link.js`, `<lair-cancel-link>` on My Lair, outside the logged-in part)
- `snippets/cancel-link-early.liquid`, first in `layout/theme.liquid`'s head on the My Lair page, takes `cancel` and
  `key` out of the fragment (`history.replaceState`) before any other script runs, so no analytics or ad script, none of
  the page's own (My Lair's hash router included), no later request's Referer and no refresh sees them. They wait in
  `window.DGCancelLink`, read once.
- A link opened in a tab that's on My Lair already changes only the fragment (no new page). The snippet's listeners
  for `popstate` and `hashchange` are the page's first, so they take the code and key, stop the event before any other
  listener of the page's (My Lair's router included) gets it, and tell the card (`dg:cancel-link`), which asks afresh.
- The card: "Can't make it?", then "Give up your seat at Candlekeep Mysteries, Sunday 8 November, 6pm?" ("Give up your
  2 seats at …", "Cancel your table for 2, …?", "Cancel your table for 2 at Warhammer night, …?", "Cancel your place at
  …?", "Cancel your 2 places at …?"), "It's free to cancel until 6pm Saturday." (or "You can cancel any time before it
  starts."), and **"Yes, give up my seat"** ("Yes, give up my seats", "Yes, cancel my table", "Yes, cancel my sign-up")
  and **"Keep it"**.
- Only that tap cancels (a POST), never the page loading: email scanners open links.
- Then the card says it as a statement ("Your seat at Candlekeep Mysteries, Sunday 8 November, 6pm") and, in its status
  line (`role="status"`): "Done. Your seat's gone back on the board for someone else." ("Done. Your seats have gone back
  on the board for someone else.", "Done. Your table's gone back for someone else.", "Done. Your place is free for
  someone else now.", "Done. Your places are free for someone else now."), plus "You'd paid already, so we'll refund $40
  to you in the next few days." when a refund's due, or the Lair's notice. Keep it: "Gobgob's keeping your seat warm.
  See you there!", "Gobgob's guarding your table. See you there!", "Gobgob's saving your place. See you there!"
- When it can't be cancelled, or the link's wrong: the Lair's words (`role="alert"`) and "Something come up? Call us on
  021 159 6894." (a tap to call; the number is Theme settings' store phone). A wrong link's title is "Cancel a booking".
- While it loads: "Gobgob is finding your booking…". No answer from the Lair: "That didn't go through. Try again, or
  call us on 021 159 6894." (and while cancelling, a 5xx says the same); too many tries (429) says the Lair's words.
  Either way, while cancelling nothing changed and the buttons work again.
- Logged in, My Lair loads again straight after (`lair:refresh`), so the booking shows cancelled.
- Demo mode (the website lab): a made-up seat with "Demo: nothing is cancelled.", and nothing reaches the Lair.
- Logged out, My Lair's **Log in** comes back to the page (`/customer_authentication/login?return_to=…`, as the header's),
  with an email's `?view=` added by script, never the cancel link's code or key.

## 2.7 Monday's weekly numbers (`src/report.js`)

Two lines in the weekly email, after "No-shows", so Mo can judge whether reminders work:
- **Booking reminders sent:** the reminders that went that week, by when they went: "38 (31 the week before)".
- **No-shows on one-off bookings:** one-off bookings by their session's week (TTRPG seats with no weekly seat behind
  them, tables, event sign-ups made ahead, not walk-ins) and their no-shows: a seat or table staff marked one, a
  sign-up that's over and wasn't checked in or paid (sign-ups have no no-show mark). "3 of 41, 7% (13% the week
  before): 2 TTRPG seats, 1 table, 0 event sign-ups not checked in or paid"; "No one-off bookings (50% the week
  before)". Weekly saved seats are left out.
- `GET /report`'s weeks gain `bookingReminders: { sent }` and `oneOff: { bookings, noShows, seats, tables, signUps }`,
  and its `words` `oneOff`.

## 2.8 Before it goes live

- A security review of the cancel link (keyed, public, cancels without a login): see the round's report.
- Going live means the live theme's settings saying `"lair_booking_reminders": true` (ticking the box in Theme settings,
  or the lab's `settings_data.json` going live with it), after the theme with the cancel card is live. Until then the
  Lair sends none. Unticking it stops them.
- Keep click tracking off for the sending domain in Resend: a tracked link goes through Resend's servers, key and all.

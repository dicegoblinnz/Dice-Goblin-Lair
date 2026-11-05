# Lair API contract v29: roleplayers, loyalty and community, Phase 1

Round 29, from 2 November 2026. Mo approved the roleplayers, loyalty and community plan ("Roleplayers, loyalty and
community: the plan") on 2 November 2026. Phase 1, in November, is the head-start loyalty card (section 1), booking
reminders (section 2) and a first game for beginners (section 3).

**Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

## 1. The head-start card

Mo (2 Nov 2026) picked mockup A, "12 slots, 2 from Gobgob":

- "Every card shows 12 slots, the first 2 already filled as Gobgob's head start, so a d20 roll still takes 10 paid
  visits. Cards in progress get the 2 as well: 7 of 10 shows as 9 of 12; 0 shows 2 of 12; 9 shows 11 of 12; the 10th
  stamp completes the card, a roll becomes available exactly as today, and the next card shows 2 of 12."
- "This is presentation only. How stamps are earned, CARD_SIZE = 10 as the counting rule, cards, rolls, credit and the
  sure $10 stay exactly as they are. No new credit or roll for anyone."
- Progress shows wherever people book: at the top of My Lair's Home, on the card, in booking confirmations on the
  website and in booking emails, and at the counter (the staff page's check-in card and member pages, and the POS
  check-in tile), each saying "X of 12".

The code: `src/core.js` (`CARD_HEAD_START`, `CARD_SLOTS`, `cardView`, `cardSoFar`, `CARD_ROW`), `src/lair.js`
(`loyaltyOf`, `staffCard`, `cardLine`, the emails) and `src/stamps.js` (`posLoyalty`). Tests:
`test/round29-headstart.test.js`, the round 29 tests in `pos-app/test/loyalty.test.mjs`, and the browser check
`tools/qa/round29-roleplayers/headstart.mjs`.

### 1.1 The card's fields

Every card the Lair sends carries the same card fields (`cardView`):

| Field | What it is |
|---|---|
| `stamps` | stamps on the card they're on, 0 to 9, as before |
| `cardSize` | stamps that fill a card: 10 (`CARD_SIZE`), as before |
| `cards` | full cards so far |
| `card` | the card they're on (`cards + 1`) |
| `slots` | the slots the card shows: 12 (`CARD_SLOTS`, `CARD_SIZE + CARD_HEAD_START`) |
| `headStart` | Gobgob's head start, at the front of them: 2 (`CARD_HEAD_START`) |
| `onCard` | the slots filled: `stamps + headStart`, 2 to 11 |

What's left to a roll is `slots - onCard`, which is `cardSize - stamps`: 10 stamps still fill a card. There's never a
"12 of 12" to wait on: the 10th stamp completes the card, its roll is ready at once (`rolls`, as before), and the next
card is 2 of 12.

Where they come:

- **GET /me** `loyalty` (and the card the roll and "Got a code?" send back): the card fields, then `rolls`, `sure`, and
  with details `recent` and `history`, as before.
- **The staff page**: `POST /checkin` with a member code (the check-in card's `loyalty`), `GET /members` and
  `GET /members/:id` (`member.loyalty`), and the stamp routes' `member.loyalty`: the card fields and `rollsAvailable`.
- **The counter**: `POST /pos/scan` (a member code, and a ticket on an account), `/pos/member`, `/pos/checkin`,
  `/pos/stamp` and `/pos/stamp-undo`: the card fields, `rollsAvailable`, and round 24's `rollsWaiting` while a welcome
  code's rolls wait.

Before round 29 they differed: the counter's had no `cards`, GET /members' no `cardSize`. Now one method makes the staff
and counter shapes (`staffCard` in `src/lair.js`). Nothing was renamed or taken away.

### 1.2 Booking emails

A member's booking emails get a row in their details, after the fee:

```
Loyalty card:  9 of 12 so far. Stamps land when you check in.
```

- In: a table or game spot's and a TTRPG seat's confirmation (`confirm()`, a paid-online one too), a weekly seat
  (`joinSeries`) and an event sign-up (`confirmJoin`).
- Only for a booking on a member's account. A guest's (no customer ID, or no Lair member with it) has no row:
  `cardLine` is null and `renderEmail` leaves an empty row out.
- The words never promise that this booking adds a stamp. A table for four stamps four times, and stamps land when
  they check in (or pay on the day).
- `cardLine(customerId, rules)` (`src/lair.js`) gives the words, with `CARD_ROW` ("Loyalty card") as the label. The
  booking reminders (section 2) and the day-after email use it too.

### 1.3 Messages

Unchanged, since 10 sessions still earn a roll: the 409 "No rolls yet, friend. Fill your card: 10 sessions earn a
roll." and the two 410s for the retired dice.

### 1.4 The theme (built in the lab)

- `assets/lair-core.js`: `Lair.cardFace(card)` reads any card for a page: `{ stamps, size, cards, card, slots,
  headStart, onCard }`. A card with no `slots` (a Lair app from before round 29) is `slots = size`, `headStart = 0`.
  The store keeps the logged-in member's card from each GET /me (`store.cardNow()`: no request of its own; the demo
  works its own out). `Lair.cardLineHtml()` is the confirmation's line, "Your loyalty card: 9 of 12. Stamps land when
  you check in.", for a logged-in member only (`.ticket__card` in `lair-core.css`), on the confirmations of a table
  (`lair-booking.js`), a TTRPG seat and a weekly seat (`lair-join.js`), and an event sign-up or game table
  (`lair-calendar.js`).
- My Lair (`sections/my-lair.liquid`, `assets/my-lair.js`, `assets/lair-my.css`):
  - The card: 12 slots, four to a row (three rows on a phone, about 60px each where there's room). Gobgob's 2 are gold
    with a darker gold ring and a sparkle. Then the stamps in green ink, the next slot ringed with its number, empty
    slots dashed with theirs (3 to 11), and the gold d20 last. The slots are a list a screen reader reads: "Head start
    from Gobgob" twice, then Stamped, Next stamp or Empty, then "Last slot: your d20 roll".
  - Under the card: "Card N · X of 12", "Y more visits to your next roll" ("1 more visit"), and "Gold is Gobgob's head
    start: every card begins with 2, so a roll is still 10 paid visits."
  - At the top of Home, a strip: "Card N · X of 12", "Y visits to your roll" in gold, and 12 pills. It's a link to the
    card.
  - After a roll, while the card has only Gobgob's 2 on it and a card has been filled (card 2 on): "Card N is ready,
    and Gobgob's already started it." A brand-new member rolling a roll staff gave them, or a loot code's, is still on
    card 1, which nobody filled, so it isn't said (the head start's review, 2 Nov 2026).
  - The Wallet: "Card N: X of 12".
  - How it works (the section's default): "Every card has 12 slots, and Gobgob fills the first 2 for you. 10 stamps
    fill the rest and earn a d20 roll."
- The staff page (`assets/lair-staff.js`): the check-in card and a member's page say "9 of 12" with "7 stamps and
  Gobgob's 2" under it, and draw 12 dots, the first 2 gold. The members list says "9/12", and the toasts say "is on
  10 of 12".
- The counter (`pos-app/extensions/lair-checkin`): three rows of four, Gobgob's 2 as gold stars, "9 of 12", "3 more
  fill the card", and "The first 2 are Gobgob's head start: a roll is still 10 paid visits."
- Demo mode (`assets/lair-demo.js`, the round 29 block) sends the same fields.

### 1.5 Old and new together

- **Today's theme and counter with this Lair app**: they get extra fields only. `stamps` and `cardSize` mean what they
  did, so they show "7 of 10" as before.
- **The new theme and counter with an older Lair app** (no `slots`): the card has its 10 slots, "Card N · 7 of 10",
  with no gold and no note. The staff page says "7 of 10 stamps", the counter is as it was, and a confirmation says
  "7 of 10".

### 1.6 Going live

The Lair app, the theme and the POS extension need to go out on the same day. Each works with the other's old version,
but in the gap the words disagree. With the Lair app first, its booking emails say "9 of 12 so far" while the live site
and the counter still say "7 of 10". With the theme first, How it works describes 12 slots on a card that still shows
10. So: the theme (lab, preview, live) and the POS extension (`shopify app deploy`), each with Mo's yes, then the Lair
app straight after. Then every screen and email changes to "X of 12" together.

### 1.7 How to tell it worked

Mo judged the mockups himself. Alongside the plan's measures (regulars, and visits per member), listen for what people
say at the counter about the gold two.

## 2. Booking reminders

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

### 2.1 Who gets one

- A **confirmed one-off TTRPG seat**: kind `gm-seat` with no `series_id` (a weekly regular's saved seat has one, and
  gets none; a one-off seat at a weekly game gets one), on a session that's live (`open`, full or not).
- A **confirmed table booking**: kind `table`. One at an event (a game table, `occurrence_id`) only while its date is on
  the calendar.
- A **confirmed event sign-up** whose date is still on the calendar.
- Each needs an email. **Never:** a walk-in, a held booking, a cancelled one, a GM's charge for a player's seat
  (`gm-cover`), the GM's own booking (`gm`), or a seat on a session that's cancelled or waiting for approval
  (`pending`). One email per booking or sign-up, to the email on it (a party's other players aren't emailed).

### 2.2 When

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

#### The 10-minute run, and `POST /internal/reminders`
- The maintenance run sends them (`result.bookingReminders`: `{ sent, seats, tables, signUps }` when any went).
- `POST /internal/reminders { at? }` (the Worker itself only, the live checks' clock) runs them at a fixed time with the
  round 11 reminders. Its answer is unchanged for those (`{ sent, dates, ok? }`, with `{ sent: 0, dates: [] }` when
  none were due); booking reminders answer under **`bookings`** (`{ sent, seats, tables, signUps, ok }`), only when some
  were due.

#### New columns (made sure of on every start, as round 15's are)
- `bookings` and `event_joins`: `reminded_at` (when it was claimed; null again if Resend was down), `reminded_start`
  (the start it went for), `cancel_key` (32 hex characters, `crypto.randomUUID()` without dashes, made when its first
  reminder is claimed, in the same step, and kept: a moved booking or a retry keeps its key).
- Indexes `bookings_reminded`, `event_joins_reminded` (only rows with a reminder).

### 2.3 The email, word for word (D1 "warm first"; Gobgob signs it; NZ English)

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

### 2.4 The deadline

`cancelRule` (round 15) decides it, as the confirmations do: something with a price booked from round 15's start locks
`refundHours` (24) before it starts. `<until>` is that moment in Lair time, "<clock> <weekday>". Across a daylight
saving change it's 24 real hours, so the clock moves: a 6pm Sunday 4 April 2027 game is free to cancel until **7pm
Saturday**, and one on 26 September 2027 until **5pm Saturday**, as the lock itself enforces.

### 2.5 `GET /ics/b/<booking id>.ics` (public)

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

### 2.6 The cancel link: one tap, no login

The email's link is `/pages/my-lair#cancel=<code>&key=<key>` (the booking's or sign-up's code, like `RM-OWLBEAR-17`,
and its `cancel_key`). They ride in the fragment, which browsers never send to a server, so the key is in no server's
logs, Shopify's included. Both routes are public, through the store's app proxy (`/apps/liar/cancel-links/…`), with the
code and key in the JSON body, never an address. Nobody is looked up: logged in or not, they work the same. The key
only ever cancels.

#### `POST /cancel-links/view { ref, key }`
→ `{ link: { kind, title, when, people, cancellable, until, reason } }` and nothing else:
- `kind`: `seat`, `table` or `signup`; `title`: the game or event ("Candlekeep Mysteries"), `null` for a plain table;
  `when`: "Sunday 8 November, 6pm"; `people`: how many it's for.
- `cancellable`: true while it can be cancelled online now; `until`: the free-cancel deadline ("6pm Saturday") while
  there is one, else `null` (nothing to pay, nothing locks: cancel any time before it starts).
- `reason` (when it can't): "That's cancelled already." / `TAB_WORDS.started` ("That one has already started, so it
  can't be cancelled online. Have a chat with us if something's not right.", also once it's checked in or marked a
  no-show) / `TAB_WORDS.locked(24)` / for a seat the GM pays for, `GM_COVER_WORDS.seatLocked(24)`.

#### `POST /cancel-links/cancel { ref, key }`
- Cancels it by **the person's own path in My Lair** (`cancelOwnBooking` for a seat or table, `cancelOwnJoin` for a
  sign-up), never a second copy: the same rules and side effects (the seat back on the board, the GM's "Seat dropped"
  email, a GM's charge for the seat stopped, a library game let go, places freed, the refund rules, staff's "Refund due"
  or "Refund?" emails).
- → `{ ok: true, kind, people, refund: { due: true, amount } | null, notice }` (`notice`: the existing words for one
  paid online, like "Your spot is cancelled. You paid online, so have a chat with us about a refund.").
- **409**, nothing changed: "That's cancelled already.", `TAB_WORDS.started`, `TAB_WORDS.locked(24)`,
  `GM_COVER_WORDS.seatLocked(24)`.

#### Both routes
- **404** "That cancel link doesn't work. Check you have the whole link from your email." for a wrong key, another
  booking's key, a code that isn't a reminded seat, table or sign-up (or a weekly seat), or either left out: one
  message, never saying which part was wrong. Keys are compared in constant time (`safeEqual`), against a stand-in
  when there's nothing to compare with.
- **429** "Too many tries. Wait a few minutes and try again, or give us a call." after 10 wrong tries from one address
  (`X-Lair-Client`) in 10 minutes, the right key too until then.

#### The website (`assets/lair-cancel-link.js`, `<lair-cancel-link>` on My Lair, outside the logged-in part)
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

### 2.7 Monday's weekly numbers (`src/report.js`)

Two lines in the weekly email, after "No-shows", so Mo can judge whether reminders work:
- **Booking reminders sent:** the reminders that went that week, by when they went: "38 (31 the week before)".
- **No-shows on one-off bookings:** one-off bookings by their session's week (TTRPG seats with no weekly seat behind
  them, tables, event sign-ups made ahead, not walk-ins) and their no-shows: a seat or table staff marked one, a
  sign-up that's over and wasn't checked in or paid (sign-ups have no no-show mark). "3 of 41, 7% (13% the week
  before): 2 TTRPG seats, 1 table, 0 event sign-ups not checked in or paid"; "No one-off bookings (50% the week
  before)". Weekly saved seats are left out.
- `GET /report`'s weeks gain `bookingReminders: { sent }` and `oneOff: { bookings, noShows, seats, tables, signUps }`,
  and its `words` `oneOff`.

### 2.8 Before it goes live

- A security review of the cancel link (keyed, public, cancels without a login): see the round's report.
- Going live means the live theme's settings saying `"lair_booking_reminders": true` (ticking the box in Theme settings,
  or the lab's `settings_data.json` going live with it), after the theme with the cancel card is live. Until then the
  Lair sends none. Unticking it stops them.
- Keep click tracking off for the sending domain in Resend: a tracked link goes through Resend's servers, key and all.

## 3. A first game for beginners

Mo approved it on 2 Nov 2026 from mockups A (the front door on the TTRPG page), B (the join sheet and "You're in") and
D3 (the email the day after a first game), with two corrections to A's words (the intro and step 2) and three to B's
(the box for the email the day after, "on the day", and the section's own access note in place of a lift sentence).
Regulars are made on the second visit: this is about getting a first-timer to a table, looked after, and back.

The code: `src/first-game.js` (mixed into the Lair like `src/booking-reminders.js`), `src/lair.js` (joining, the GM's
email, GET /me, the staff views, the routes and the 10-minute run), `src/index.js` (the one-click unsubscribe),
`src/email.js` (`detailsAfter`, `unsubscribe`), `src/shopify.js` (an email's own `headers`), `src/report.js`,
`src/sessions-feed.js`, and the counter's `pos-app/extensions/lair-checkin/src/today.js` and `views.jsx`. Theme:
`snippets/lair-first-game.liquid`, `sections/lair-play.liquid`, `templates/page.gm-games.json`, `assets/lair-play.js`,
`assets/lair-join.js`, `assets/lair-games.js` and `.css`, `assets/lair-core.js`, `snippets/lair-config.liquid`,
`assets/lair-staff.js` and `.css`, `assets/lair-demo.js`, `snippets/unsubscribe-early.liquid`,
`snippets/lair-unsubscribe.liquid`, `assets/lair-unsubscribe.js`, `layout/theme.liquid`, `sections/my-lair.liquid` and
`locales/en.default.json` (`lair.first_game`, `lair.unsubscribe`). Checks: `test/round29-firstgame.test.js`,
`test/round20-sessions-feed.test.js`, `pos-app/test/today.test.mjs`, and in the browser
`tools/qa/round29-roleplayers/first-game.mjs`.

### 3.1 Has this member played? (`GET /me` `ttrpgPlayed`)

- `ttrpgPlayed: true | false` on GET /me (logged in): whether they've had a TTRPG seat (`gm-seat`) at the Lair that
  counts as a visit, the loyalty card's rule (`bookingStamps`): checked in (`seated`, `done`), or confirmed and paid in
  full once its day came. By their account, or their account's verified email (a seat booked as a guest with it counts),
  one look each way, as round 18's `isNewPlayer` looks.
- The theme hides the front door (3.8) for a member who's played, and the join sheet doesn't ask them (3.2). Logged
  out, nobody is looked up: the front door shows and the sheet asks.

### 3.2 Joining: "Is this your first roleplaying game?"

- `POST /bookings` (`kind: 'gm-seat'`) and `POST /games/:id/join-series` take two optional fields:
  - `firstGame`: `true` ("Yes, my first"), `false` ("I've played before"); anything else (left out) is not answered.
  - `followUp`: after `firstGame: true` only, the box "Email me the day after about keeping my seat" (a weekly game) or
    "… about my next game" (any other), `true` when ticked. It starts unticked. The email the day after is marketing
    under New Zealand's Unsolicited Electronic Messages Act 2007, and the regulator doesn't infer consent from a
    booking, so it only goes with the box ticked.
- Kept on the seat (new columns, made sure of on every start): `bookings.first_game` (1, 0 or null, and never
  `new_player`, which is staff's own mark for the seats kept for new players), `followup_ok` (1 or 0 after a yes, else
  null) and `followup_ok_at` (when). Joining every week keeps the answer on the seat it books now; a full next session
  books none, and nothing is kept.
- It never stops anyone joining. A table or a walk-in ignores it, and staff's Add players doesn't ask it.
- `POST /bookings`'s answer for a TTRPG seat adds `reminderDay`: the weekday its two-day reminder (section 2) will go,
  like `"Friday"`, or `null` when none will (emails not set up, reminders switched off, booked on the reminder day or
  later, no email). A weekly seat's answer has none (saved weekly seats get no reminder).

### 3.3 The GM's email

The new-player email (round 6's `tellGmNewPlayer`) adds, after its first line, "It's Ria's first roleplaying game."
(the first word of the name on the seat) when the seat says `firstGame`. Weekly regulars' later seats, which the Lair
books as sessions end, send no email, as before.

### 3.4 The counter (staff only)

- `firstGame: true` on a first game's seat (`first_game` 1) in staff's views: the staff floor's bookings, the check-in
  rows (`POST /checkin`, the member card's list), and the counter's `/pos/today`, `/pos/scan` and `/pos/checkin`.
  Never in a customer's view (GET /me, the public floor, a GM's roster), and an older seat with no answer has nothing.
- The staff page: a "First game" badge and "Walk them to their GM, and point out drinks, the bathroom and the lift." on
  the seat's check-in card, in a member's check-in list and on the floor's booking card, and the badge in a session's
  players.
- The POS extension: a "First game" badge in Today's list (`rowBadges`), and the same words on the person's page and,
  once they're checked in, as a banner (`FIRST_GAME`, `firstGameHint` in `today.js`).

### 3.5 The email the day after a first game (mockup D3; Gobgob signs it; NZ English)

**Who:** a first game's seat (`first_game` 1) with the box ticked (`followup_ok` 1) that was checked in (`seated`, or
`done` once they've left), with an email. **When:** on the Lair day after the session, from 9am, never at or after
9pm (the round 11 window), once. **Never** when:

- they've booked a later session of that game since (a live seat by their account or their email), or saved a weekly
  seat in it;
- their email is on the stop list (3.6);
- they didn't come (no-show, cancelled), didn't tick the box, or said "I've played before".

Claimed before it's sent (`followup_at`, with the email's own unsubscribe key, `followup_key`, 32 hex characters, kept
on a retry). Resend down or busy (5xx or 429): the claim comes off and the next run tries again; anything else isn't
tried again. At most 100 a run. The 10-minute run sends them (`result.nextDay: { sent }`), and `POST /internal/next-day
{ at? }` (the Worker only, the checks' clock) runs them at a fixed time (`{ sent, ok }`, or `{ sent: 0 }`). Daylight
saving changes nothing: the day and the hours are Lair time.

**A weekly game whose next session has a seat anyone can book** (D3):

- **Subject:** "How was your first game, Ria?" ("How was your first game?" with no name)
- **Preheader:** "Candlekeep Mysteries runs again on Sunday. Want your seat?"
- **Title:** "How was your first game?"
- **Intro:** "Thanks for coming to Candlekeep Mysteries on Sunday, Ria. Gobgob hopes the dice were kind." then "The same
  table plays every Sunday at 6pm. Save your seat and it's yours each week until you give it up. You pay at the
  counter each time, $15." (the price left out for a free one)
- **Button:** "Save my seat every week": the GM games page with that session's join sheet open, every week picked
  (`/pages/gm-games?join=<next session>&every=1`; a guest is asked to log in first, as joining every week needs an
  account).
- **Links:** "Just next Sunday" (`?join=<next session>`, one-off) · "Try a different game" (the GM games page).
- **Details, after them:** Next session "Sunday 15 November, 6pm to 10pm"; Seats left "3"; Loyalty card (section 1's
  `cardLine`, a member's only).
- **Outro:** "Not quite your thing? That's fine. 2 other beginner games have seats this week." ("1 other beginner game
  has…"), left out when there are none.

**Anything else** (a one-shot, a fortnightly or flexible game, or a weekly one with its next session full or none
listed) is built the same way as D3 (Mo, 6 Nov 2026, of the D3 preview: "This one is the best please use that"),
offering the soonest beginner game with seats this week:

- **Subject, title and thanks:** as D3.
- **Preheader:** "Daggerheart: first flight has seats on Wednesday. Want one?" ("… has seats tomorrow.", "… today.")
- **Intro:** the thanks, then "Fancy another? Daggerheart: first flight is on Wednesday at 6pm, and new players are
  welcome. You pay at the counter on the day, $15." ("is tomorrow at 6pm", "is today at 6pm"; the price left out for a
  free one)
- **Button:** "Save me a seat": the GM games page with that session's join sheet open (`/pages/gm-games?join=<id>`).
- **Links:** "Try a different game" (the GM games page).
- **Details, after them:** When "Wednesday 11 November, 6pm to 9pm"; Seats left "4"; Loyalty card (a member's only).
- **Outro:** "Not quite your thing? That's fine. 1 other beginner game has seats this week." (the others, not counting
  the one offered), left out when there are none.

With **no beginner game with seats this week**: the thanks, then "Fancy another? No beginner games have seats left
this week, but GMs add new ones all the time.", the button "Find your next game" (the GM games page), and the Loyalty
card row (a member's only).

"Beginner games with seats this week" are found as the front door finds them (3.8): public sessions for new players
(level `new`), open with a seat anyone can book, starting in the next 7 days, a weekly game's next session only, not
the game they played; soonest first.

**Every one** ends with the shop's details (the layout's footer: Dice Goblin Lair, the address, phone and hours) and
"Don't send me emails like this", a link to `/pages/my-lair#unsubscribe=<code>.<key>` (the seat's code and the email's
key). It carries `List-Unsubscribe: <https://<Lair app>/unsubscribe/<code>/<key>>` and `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058), so mail apps show their own Unsubscribe button.

### 3.6 "Don't send me emails like this"

Both routes are public, through the store's app proxy (`/apps/liar/unsubscribe/…`), with the code and key in the JSON
body. Nobody is looked up. Keys are compared in constant time (`safeEqual`), against a stand-in when there's nothing
to compare with.

- `POST /unsubscribe/view { ref, key }` → `{ link: { stopped } }`: whether that email has stopped these already, and
  nothing else. Seeing it never stops anything: email scanners open links.
- `POST /unsubscribe/stop { ref, key }` (the tap) → `{ ok: true, already }`. The email (lower case) goes on the stop
  list straight away (`followup_stops`: `email`, `at`, `ref`, `via` 'link'), and no email the day after goes to it
  again, from any seat. Booking confirmations and reminders aren't marketing, and still go.
- **It reaches Shopify.** Using an unsubscribe withdraws consent to all of Dice Goblin's marketing emails, not just
  these (the Unsolicited Electronic Messages Act 2007, sections 9(2) and 11(1)(a), within 5 working days), and
  Shopify's email marketing setting is the one list of who may get them. So straight after a stop, in the background,
  `pushStopsToShopify` finds the customer with that email (`customerByIdentifier`, `read_customers`) and, when Shopify
  has them subscribed or pending, sets them to unsubscribed as of the stop (`customerEmailMarketingConsentUpdate`,
  `write_customers`, which Mo approves once in Shopify admin after the deploy that adds it). Nothing to change for
  someone Shopify doesn't have, or who isn't subscribed there. Done: `shopify_at`. Not done (Shopify down, the
  permission not approved yet): `shopify_tries` and `shopify_error`, and the 10-minute run tries again
  (`result.stopsToShopify: { done, failed }`), at most 20 a run, one push after another so none is sent twice.
- **And the other way.** Before the email the day after goes, the 10-minute run asks Shopify about each one due: an
  email unsubscribed there since they ticked the box (or at a time Shopify doesn't give), or marked invalid or
  redacted, gets none (`followup_at` set with `followup_skipped` 'shopify', and no key, so it isn't asked about again).
  Unsubscribed before they ticked it: the box is fresh consent to this one email, so it goes. Shopify not answering:
  none go that run, and nothing is marked.
- **404** "That link doesn't work. Check you have the whole link from your email." for a wrong key, a code that isn't a
  first game's email, or either left out: one message, never saying which. **429** "Too many tries. Wait a few minutes
  and try again, or give us a call." after 10 wrong tries from one address in 10 minutes.
- **The one-click route**, on the Lair app's own address (`src/index.js`): `POST /unsubscribe/<code>/<key>` (the mail
  app) stops them the same way (`via` 'one-click') and answers 200 "Done. No more news emails from Dice Goblin." (plain text;
  the 404 and 429 above as plain text). `GET` or `HEAD` (someone opening it, or a scanner) stops nothing: a 303 to My
  Lair's page with the link in its #fragment.
- The website (`<lair-unsubscribe>` on My Lair, outside the logged-in part, `assets/lair-unsubscribe.js`):
  `snippets/unsubscribe-early.liquid`, first in `layout/theme.liquid`'s head on My Lair, takes the link out of the
  address before any other script runs (`window.DGUnsubscribe`), so the key is never in a server's logs (it's a
  #fragment), an analytics or ad script, or a later request's Referer. The card says what the law makes it do:
  "Emails from Gobgob", "Stop news emails from Dice Goblin?", "That's this email after a first game and any other news
  from Dice Goblin. Booking confirmations and reminders still come." and **"Yes, stop these emails"**. After the tap:
  "News emails from Dice Goblin", "Done. No more news emails from Dice Goblin." (the status line) and "Booking
  confirmations and reminders still come, so you know what's booked." The link again: "You've already stopped these.
  No more news emails from Dice Goblin." A wrong link: the Lair's words and "Something not right? Call
  us on 021 159 6894." (a tap to call). While it loads: "Gobgob is finding your email…"; no answer: "That didn't go
  through. Try again, or call us on 021 159 6894." A link opened in a tab already on My Lair (only the #fragment
  changes) works the same: the snippet's `popstate` and `hashchange` listeners are the page's first (after the cancel
  link's, which leave an unsubscribe link alone), so they take the link, stop the event before any other listener of the
  page's (My Lair's router included) gets it, and tell the card (`dg:unsubscribe-link`). Each link is a new run of the
  card: a slow answer for an earlier link never lands on a later one's card. Demo: "Demo: nothing is changed."

### 3.7 Monday's weekly numbers (`src/report.js`)

Three lines after "New players":

- **First games, back within 4 weeks:** first-time TTRPG players (a first game they came to) back at another TTRPG seat
  within 4 weeks, for the week of first games whose 4 weeks are up: "2 of 4, 50% (first games 12–18 Oct; 1 of 1 the
  week before)", or "No first games 12–18 Oct (none the week before)".
- **Days between visits:** the median, for people with an account who came on 2 or more days in the last 8 weeks, of
  their average days between those days: "7 days, the median for 3 people who came on 2 or more days in the last 8
  weeks (13.5 the week before)", or "Nobody came on 2 or more days in the last 8 weeks".
- **Loyalty cards filled, last 4 weeks:** cards that got their 10th stamp: "3 (1 the week before)".
- `GET /report`'s weeks gain `firstGames: { week, players, back }`, `visitGap: { median, people }` and `cardsFilled`,
  and its `words` `firstGames`, `visitGap` and `cardsFilled`.

### 3.8 The website

- **The sessions feed** (round 20's shop metafield `lair.sessions`) gives each session `characters`: `pregens`,
  `at-table`, `bring`, or `''` when its GM didn't say.
- **The front door** (`snippets/lair-first-game.liquid`, on the TTRPG sessions page only; mockup A): "New to
  roleplaying?", "Your first game, sorted", "Never played? That's fine. These games are made for beginners, and your GM
  walks you through it.", three steps ("**Pick a game.** Look for **Character ready** if you'd rather not make one.",
  "**Say it's your first game when you book.** Your GM gets a heads-up.", "**Come up and say hi.** We'll walk you to
  your table."), "This week, with seats left" and up to 3 cards, "See all 4 games this week", "A seat is $15 to $20,
  paid at the counter on the day. Cancel free up to 24 hours before." and Gobgob: "Nobody's born knowing the rules,
  friend. That's what the GM is for." The words are the section's settings (Your first game), these their defaults.
  - Cards: public sessions for new players with a seat left, starting in the next 7 days, a weekly game's next session
    only, soonest first: the title and seat price, "D&D 5e · Sun 8 Nov, 6pm to 10pm · weekly", how a beginner gets a
    character ("Character ready", "Made together at the table", "Bring your own character"), the seats left (gold at 2
    or fewer), and **Join · $15**, a link to `?join=<session>` that opens its join sheet in place. Printed from the
    feed, so they show before any script runs, then drawn again from the board's own data by the same rules (nothing
    moves). None: "No beginner games have seats left this week. GMs add new ones all the time, so keep an eye on the
    board below, friend."
  - See all counts every public session in the next 7 days, shown from 2, and goes to the sessions list (or the day).
    The cost line is the cards' seat prices and the cancel cut-off; it's left out with no cards.
  - It sits above For GMs and organisers; Where Your first game sits: Below puts it under them.
  - Logged out, it always shows. A member's starts hidden and shows unless GET /me says `ttrpgPlayed`; this browser
    keeps the answer (`dg-lair-played:<customer>`), so next time it's right before the first paint. No answer from the
    Lair app, or an older one: it shows.
- **The join sheet** (`assets/lair-join.js`; mockup B): "Is this your first roleplaying game? (optional)" with "Yes, my
  first" and "I've played before", neither picked, unless GET /me says they've played. After Yes: "Your GM will know
  it's your first game." and the character line ("**Your character's ready for you**, so just bring yourself.", "**You'll
  make your character together at the table**, so just bring yourself." or "**This game asks you to bring your own
  character.**"), and the unticked box (3.2).
- **"You're in, Ria!"** after a "Yes, my first" seat: What happens next, in order: "Your GM gets an email saying it's
  your first game." (when the Lair app sends emails), "We'll email you on Friday as a reminder." (only with
  `reminderDay`), "On Sunday, come up to the Lair, above Whitcoulls, a few minutes early." ("Today, …", "Tomorrow, …",
  "On Sunday 15 November, …" further ahead), "Give your name at the counter. We'll walk you to your table and introduce
  your GM.", "Pay the $15 at the counter on the day." ("Nothing to pay: this seat's free.", "Nothing to pay at the
  counter: your pass covers it."), then the section's access note. The ticket, the tab lines and the loyalty card line
  follow as before (no second card line). Joining every week: the same, without the reminder.
- **A game's sheet** (`#game=`) shows the same character tag beside its system and schedule.
- **Demo mode** (the lab, `assets/lair-demo.js`): GET /me's `ttrpgPlayed`, the answer and the box kept on the seat,
  the GM's email line, `reminderDay`, and `firstGame` on check-in rows.

### 3.9 Old and new together

- **Today's theme with this Lair app:** nothing asks, so nothing is kept: no seat says it's a first game and no email
  the day after goes. GET /me and the feed have fields it doesn't read.
- **The new theme with an older Lair app:** the sheet asks, and the Lair ignores the answer (no "First game" anywhere,
  no email). GET /me has no `ttrpgPlayed`, so the front door shows to everyone and the sheet asks everyone. The
  confirmation says no reminder day. The cards have no character tag until the feed has `characters`.

### 3.10 Before it goes live

- The email the day after only goes to seats whose box was ticked, and the box is only on the new join sheet, so
  nothing sends before the new theme is live.
- A security review of the unsubscribe link and the one-click route (keyed, public, no login).
- `reminderDay` uses section 2's switch the way the run does (`rules.bookingReminders` must be `true`, so it's null until
  the live theme's settings say true), so the confirmation never promises a reminder that won't go.
- Mo's calls (the safest reading for now): the box at a game that isn't weekly says "about my next game"; only weekly
  games get "Save my seat every week" (fortnightly and flexible ones get the soonest beginner game, as a one-shot does);
  See all counts every TTRPG session this week, not only beginner ones.

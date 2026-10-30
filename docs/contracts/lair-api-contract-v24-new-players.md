# Lair API contract v24-new-players: welcome codes, how people found us, and new players by channel

Round 24 (31 Oct 2026). From Mo, 31 Oct 2026, planning Dice Goblin's ads (they start on 9 November):

- "The ad only welcome can be a hook for people joining dice goblin. So that could be cool."
- "Happy with welcome codes but I want it only given out after their first event at dice goblin not a free dice roll.
  They need to come and pay using their id or qr etc. Then they get a dice for it. Otherwise it won't work for me to give
  people free credit."
- "Alright do what you think is the best next step": the Lair counts new players by channel before the ads start.

The code: `src/newplayers.js` (welcome codes, "How did you find us?", ad tags), `src/lair.js` (`redeemCode`,
`rollCodeFields`, `createRollCode`, `updateRollCode`, `rollCodeView`, `stampTally`, `loyaltyOf`, `posScan`,
`memberDetail`, `me`, `createBooking`, `joinEvent`, `reserveSpot`, `joinSeries` and the routes), `src/stamps.js`
(`posLoyalty`), `src/report.js` (`firstVisits`, `newPlayerWords`, the week's `newPlayers`) and `src/index.js`
(`POS_ROUTES`). The counter: `pos-app/extensions/lair-checkin/src/foundus.js`, `flow.js`, `lair.js`, `loyalty.js`,
`views.jsx` and `Modal.jsx`. The theme: `assets/theme.js`, `lair-core.js`, `my-lair.js`, `lair-my.css`,
`lair-staff-codes.js`, `lair-staff.js` and `lair-demo.js`. Tests: `test/round24-new-players.test.js`,
`pos-app/test/foundus.test.mjs` (and round 7's shape checks, which now expect `welcome` and the four new codes), and the
browser check `tools/qa/round24/new-players.mjs`.

## Why

- The ads are judged on what they cost for each new player, so the Lair has to know who is new and how they found it.
  The ad platforms count clicks and views and credit themselves generously; the Lair knows who came in and paid.
- A welcome code is the hook in the ad and the label on the person: SCROLL-ROLL on someone's account says Facebook or
  Instagram brought them.
- Mo doesn't give store credit to people who haven't come in and paid, so a welcome roll is earned at their first paid
  session, never by signing up.
- Plenty of people won't type a code. The counter asking a new player "How did you find us?" (one tap) and the ad link
  a booking came from catch most of the rest.

## 1. Welcome codes

A loot code (round 7) can be a welcome code: `roll_codes.pays_on` is `'first-session'` (null for an ordinary one).

**Typed in "Got a code?"** (`POST /me/codes/redeem { code }`), after the loot code checks every code gets (already used
by them: 409; switched off, past its last day or used up: 410):

- They used a welcome code already (any of them): 409 "You've used a welcome code already. It's one per player."
- They've been to Dice Goblin before today (`playedBefore`): a stamped session that started before today; a table,
  walk-in, TTRPG seat or sign-up they were on (as the booker, a named player or a guest) checked in or paid before today,
  from before the loyalty card too; or a counter purchase with their account on the sale before today (Shopify POS's own
  or Pay on Verifone's). 409 "That's a welcome code for players new to the Lair, and you've played with us before. Thanks
  for coming back!" Nothing is saved. Today doesn't count against them, so someone can check in and pay for their first
  session at the counter and type the code after. An online-only customer is still new: buying online isn't a visit.
- Otherwise the use is saved (`roll_code_uses.pays_on` 'first-session', no grant), and the answer is
  `{ kind: 'welcome', rolls: 0, waiting, message, loyalty }`: "Saved! Your welcome roll unlocks after your first paid
  session at the Lair. Show your member code at the counter when you pay, and it's yours." (2 or more: "Saved! Your 2
  welcome rolls unlock … and they're yours.") A My Lair from before round 24 shows a `welcome` answer's message the way it
  shows a pass's, and offers no roll.
- When they've had a paid session already (today, at the counter), the rolls are ready at once:
  `{ kind: 'roll', rolls, waiting: 0, message, loyalty }`, "Welcome to the Lair! Your welcome roll is ready on Home,
  friend." ("Your 3 welcome rolls are ready on Home, friend.")

One welcome code a member is also kept by a unique index (`roll_code_uses_welcome`), so two codes typed at the same
moment save one.

**Their first paid session** (`paidSession`; Mo: "They need to come and pay using their id or qr") is a session on
their card (round 22's `stampTally`) that has started, or that they're checked in for, and that they paid for
themselves:
- their own table, walk-in, TTRPG seat or sign-up, paid in full (`paid` 1) with money or a session pass
  (`paid_amount > 0` or `covered > 0`);
- a payment of theirs (`payments.customer_id`: their code on the sale) towards someone else's, as a named player paying
  their share or a guest paying their part, or towards a session with no account on it;
- a Session product rung up at the counter on their sale for more than $0 (`loyalty_stamps.amount`, from the line's
  price after discounts); or
- a stamp staff added by hand.

A free session, one staff let them off (waived), a seat their GM pays for, a GM's own session and someone else paying for
them don't count. Checked in without paying, or paid ahead for later today, the roll waits. (These came from the
review: at first any money towards a stamped session counted, so a friend paying, one share of a split table, a session
paid ahead or a $0 Session could have released it.)

**Like stamps, it's worked out every time** (`welcomeOf`), never stored. A paid session marked a no-show or cancelled
puts the roll back to waiting; one already rolled stays rolled, and the card never goes below none.

**The card** (`loyalty` in GET /me, the roll's and "Got a code?"'s answers): ready welcome rolls count in
`rolls.earned.codes` and `rolls.available` like any loot code's. While some wait, `rolls.waiting` says how many (it's
left out when none do, so a card is as it was for everyone else). They're rolled like any roll: the d20 or the sure $10.

**The counter's card** (`loyalty` on `POST /pos/scan` for a member code or a ticket on an account, and the stamp routes'
answers) adds `rollsWaiting`, again only while some wait.

**A member's page** (GET /members/:id) adds `welcome`: `{ code, at, rolls, waiting }` (waiting: true while it waits for
their first paid session), or null.

**Staff** (Money, as for every loot code): `POST /roll-codes { …, welcome: true }` makes a welcome code, and
`POST /roll-codes/:id/update { welcome: true | false }` switches one. Anything but true or false: 422 "That Welcome code
tick didn't come through properly. Try again." A use keeps what the code was when it was typed. `GET /roll-codes` lists
each code with `welcome: true | false`.

**The four codes** are made once on the Lair app's first start with this round (meta `welcome-codes`), 1 roll each, no
limit and no last day, made by `setup`, one for each channel in the ads plan:

| Code | Note |
| --- | --- |
| SEARCH-ROLL | Welcome code for Google |
| SCROLL-ROLL | Welcome code for Facebook and Instagram |
| TOK-ROLL | Welcome code for TikTok |
| UPVOTE-ROLL | Welcome code for Reddit |

A code whose text is taken already is skipped. Staff switch any of them off on the Loot codes tab, and they're never
made again.

## 2. "How did you find us?"

`members.found_us`, `found_us_at` and `found_us_by` ('me', 'pos:<user>' or 'staff:<customer id>'). The answers, in the
order the counter shows them: google (Google), facebook (Facebook), instagram (Instagram), tiktok (TikTok), reddit
(Reddit), friend (A friend), walked-past (Walked past), discord (Discord), other (Something else). The latest answer
stands. As the Lair shows it: `foundUs: { answer, label, at, by }` (by: 'me', 'the counter' or a team member's first
name), or null.

- `POST /pos/found-us { customerId, answer }` (the counter): `{ foundUs }`. A member code's `POST /pos/scan` adds
  `foundUs` and `newHere` (true on a new player's first day: no session before today), and the counter asks while
  `newHere` and nobody has answered.
- `POST /me/found-us { answer }` (logged in): their own answer, `{ foundUs }`. GET /me adds `foundUs`. Someone the Lair
  hasn't met yet (no GET /me) is a 404: making their member record here would give them a member code without their name.
- `POST /members/:customerId/found-us { answer }` (staff with Check-in or Members): `{ foundUs }`; `answer: null` clears
  it, and no `answer` at all is a 422. GET /members/:id adds `foundUs`.
- An answer that isn't one of these: 422 "Pick one of the answers." (the counter and My Lair can't clear one). No such
  member: 404 "No member with that customer ID."

## 3. Ad tags

The ad tags of the link someone arrived by: `ad: { source, medium?, campaign? }`, the link's `utm_source`,
`utm_medium` and `utm_campaign`. Cleaned (`cleanAd`): lower case, letters, numbers, dots, underscores, pluses and dashes
(anything else becomes a dash), at most 40 characters (80 for the campaign). Without a source, or for anything that
isn't tags, nothing is saved, and the request goes ahead: an ad tag never stops a booking.

- Taken by `POST /bookings` (tables and TTRPG seats made online, not what staff make for someone),
  `POST /events/:id/join`, `POST /events/:id/reserve` and `POST /games/:id/join-series`.
- Saved on the booking or sign-up (`ad_source`, `ad_medium`, `ad_campaign` on `bookings` and `event_joins`), and on the
  member as their first (`members.ad_source`, `ad_medium`, `ad_campaign`, `ad_at`) when they're logged in and have none.
  A later ad never replaces a member's first. A weekly seat keeps them on the member only.
- `POST /me/ad { source, medium?, campaign? }` (logged in): the website sends the tags it kept once GET /me has answered.
  `{ saved: true }` when they were the member's first, else `{ saved: false }`. Someone the Lair hasn't met yet is a 404
  (from the review: making their member record here, without their name, gave them a DG- member code).

## 4. New players in the weekly numbers

Each week in `GET /report` adds `newPlayers: { total, codes: { 'SCROLL-ROLL': 1 }, ads: { 'google/paid': 1 },
answers: { 'walked-past': 1 }, unknown }`, and `words.newPlayer`: "A new player has an account and made their first
visit that week. Each is counted once: by the welcome code they used, else the ad link they first came by, else what
they told us when asked how they found us."

- A visit is round 19's (checked in, or paid on the day), as the booker, a named player or a guest with an account. The
  first visit ever counts, however long ago, so someone back after a while is never new, and neither is someone who
  bought at the counter before it (section 7). Friends without an account are in the visits, never new players. The
  Lair's records start in September and October 2026, so the first weeks include some long-time customers' first
  recorded visits; compare the weeks after 9 November with the weeks just before.
- `ads` keys are `source/medium` (`none` without a medium).
- The Monday email adds a line, beside the week before: "New players: 3 (1 the week before): 1 by welcome code
  (SCROLL-ROLL 1), 1 by ad link (google/paid 1), 1 told us (Walked past 1)", with ", 1 not known" when there are some.

## 5. The counter (POS extension)

- A member code scanned on a new player's first day (`newHere`, no `foundUs`) shows "How did they find us?" under the
  loyalty card: the nine answers as buttons. One tap saves it (`POST /pos/found-us`), says "Saved: Instagram" and the
  question goes. Staff can ignore it; nothing waits on it.
- The loyalty card says "Welcome roll waiting: theirs once they've paid for a session." ("2 welcome rolls waiting: …")
  while `rollsWaiting`.

## 6. The website (built in the lab first: `website-lab`)

- Every page (`assets/theme.js`) keeps the first ad link this browser arrives by, for 30 days (`localStorage`
  `lair-ad`): its `utm_source`, `utm_medium` and `utm_campaign`, cleaned as the Lair cleans them; Google's `gclid`,
  `gbraid` or `wbraid` alone is google/cpc. A later link never replaces it until it's 30 days old.
- `assets/lair-core.js` sends them as `ad` with table bookings, TTRPG seats, sign-ups, game spots and weekly seats (and
  nothing else), and once with `POST /me/ad` after GET /me has answered on a Lair page, so the Lair has made the member
  (and their member code from their name) first. From the review: the tags belong to the first account that uses them in
  that browser (`owner` in `lair-ad`), so someone else logging in on a shared computer isn't credited to that ad and
  their bookings carry none; and a refused `POST /me/ad` (a Lair app without it) waits a day (`retryAt`) instead of
  trying on every page.
- My Lair (`assets/my-lair.js`): "Got a code?" shows a welcome code's message with no Roll it now, and Home's loyalty
  card says "Your welcome roll is waiting, friend. It unlocks after your first paid session at the Lair." ("Your 2
  welcome rolls are waiting, friend. They unlock …") while `rolls.waiting`, in place of "No rolls yet".
- The staff page: Loot codes (`assets/lair-staff-codes.js`) has a Welcome code tick on Make a loot code and on Edit,
  and a Welcome badge, with "1 roll for a new player, once they've paid for their first session". The tick shows only
  once the Lair app has listed its codes with `welcome` (from the review: with a Lair app that doesn't know welcome codes,
  a ticked code would quietly pay out at once). A member's page lists
  Found us ("Instagram (at the counter, Sun 1 Nov)", or "Not asked yet") and Welcome code ("SCROLL-ROLL · roll waits
  for their first paid session", "… · roll unlocked" or "None"). Changing an answer there, and the weekly numbers on the
  staff page, can come later: the Monday email and GET /report have new players now.
- Demo mode (`assets/lair-demo.js`) has the four welcome codes, and its welcome roll unlocks with any session or stamp on
  the card from the day the code was typed, so the lab can show both states.
- The browser check: `tools/qa/round24/new-players.mjs` (the theme mock, demo and live with a stand-in Lair app).

## 7. Checks for the counter's records

`loyalty_stamps.amount` (made sure of on every start, once the ledger's table is there): what a Session rung up at the
counter paid a unit, in cents. Null for the ones before round 24, which never count as a first paid session.

The weekly numbers leave out a member whose counter purchase (their account on the sale) came more than 12 hours
(`PAID_BEFORE`) before their first visit: they'd been to Dice Goblin before, so their first recorded visit isn't a new
player.

## 8. Going live

The Lair app first: the four codes are made on its first start, and nothing changes for the live theme (a welcome
code's `welcome` answer shows as a message; nothing sends ad tags yet). Then the counter's extension (it asks only when
the Lair says `newHere`). Then the theme, through the preview to the live theme. Round 7's ROLL-FOR-LOOT is still an
ordinary code that gives every customer a roll at once: check it's switched off on the Loot codes tab (or tick it
Welcome code). Before the ads start, switch off any
code whose channel isn't running yet, or leave them on: only someone new can use one, and it gives nothing until
they've paid for a session.

## How to tell it worked

New players a week, by channel, against the weeks before 9 November (the baseline), and each channel's spend divided
by its new players (the ads plan's target is $25 or less, $35 at most). Alongside: welcome rolls waiting against paid
out, how many new players are "not known" (fewer as the counter asks), and the check-in rate (scans are what make it
count).

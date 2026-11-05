# Lair API contract v30: library members free, and games that stay in the Lair

Round 30, 6 November 2026, from two of Mo's decisions on 2 November 2026:

1. **Board Game Night is free for library members.** "Library members (an active Lair library membership, Grab, Stash
   or Hoard) get in free; everyone else pays the usual $10 at the counter." The first one is Wednesday 11 November.
2. **Some library games stay in the Lair.** They "cannot even be borrowed only played in store", and can't be bought:
   Mechs vs. Minions (League of Legends) and Firefly: The Game, tagged `In Store Only` in Shopify.

**Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

The code: `src/library-rules.js` (the words and the rules), with small changes in `src/lair.js`, `src/community.js`
(walk-ins), `src/queue.js` (postal swaps), `src/shopify.js` (reading `member_free` and the tag), `src/core.js` (event
dates, the tag's handle), `src/booking-reminders.js` (one line) and `src/pick.js` (the tag's handle now comes from
`core.js`). Tests: `test/round30-library.test.js` (18 checks).

What Shopify had on 6 November 2026 (read only): the `lair_event` definition has the boolean field `member_free`
("Free for library members"), and the entry `board-game-night` has it `true` (monthly from Wed 11 Nov 2026, 6pm to
11pm, entry fee 10.0, no capacity, "In store", price note "Library members free, everyone else $10"). Mechs vs. Minions
(League of Legends) (Library), product 7498140319847, shelf code DGL34-L016, and Firefly: The Game (Library), product
10258379407463, shelf code DGL34-L027, are both tagged `In Store Only`, one copy each.

## 1. Free for library members

### 1.1 The event

- `lair_event.member_free` (boolean, "Free for library members"): `true` lets library members in free. Empty or `false`
  doesn't.
- The Lair reads it with the other fields (`loadLairData` and the events editor's `eventRule`) as `memberFree`, and
  every date of the event carries it (`eventOccurrences`, `findOccurrence`: `memberFree: true | false`).
- It only matters with an entry fee: an event with no fee is free for everyone already.

### 1.2 Who's a library member

Someone whose library plan lets them borrow today: `planOf(customerId)` gives a plan and it isn't blocked
(`checkPlanOpen` would let them borrow). That's the library's own test, the one `POST /library/scan` uses.

| Their library membership | At a members-free event |
| --- | --- |
| Grab, Stash or Hoard, active | free |
| Cancelled, still inside the month they paid for (`cancelling`) | free |
| A payment that didn't go through (`past_due`: borrowing paused), including one waiting on their bank's check | **pays** |
| Paused in Shopify, ended, or none | pays |

Simplee's tags are off (`MEMBERSHIPS_SIMPLEE_TAGS` = `off` since 9 Oct), so it's their Lair membership. Were the tags on,
they'd count for someone who has never had a Lair membership, from the request (their own sign-up) or the last tags the
Lair saw for them (`queueTags`).

Every Lair membership makes its member record with a member code when Shopify tells the Lair about it, so every library
member has a code to show at the counter (My Lair › their Goblin card).

### 1.3 Walk-ins: `POST /events/:occurrenceId/attend` (staff, Check-in)

How a library member gets into Board Game Night: it takes no sign-ups (no capacity), so they come to the counter and
staff walk them in by member code (the staff page: Today's bookings › Walk-ins at today's events), as for any event.

At a date with `memberFree` and an entry fee:

- **A library member** (1.2): the checked-in sign-up's `amount` is 0 and it says `memberFree: true` (the `join` and the
  `row`). The message says so in place of what to charge:
  `Walk-in added and checked in: Sam Jones for Board Game Night. Library member: free entry.`
- **A membership whose payment didn't go through**: they pay the entry, and the message says why:
  `Walk-in added and checked in: Kiri Smith for Board Game Night. Charge $10. Their last library payment didn't go through, so entry isn't free today.`
  or, while their bank wants them to confirm it,
  `… Charge $10. Their last library payment is waiting on their bank's check, so entry isn't free today.`
- **Anyone else** pays as before: `Walk-in added and checked in: Leo Tane for Board Game Night. Charge $10.`

At any other event nothing changes, library members included.

### 1.4 Sign-ups (an event that takes them)

Board Game Night doesn't take sign-ups. For one that does and is free for library members:

- `POST /events/:occurrenceId/join` (the account holder signs up) and `POST /events/:occurrenceId/joins` (staff add an
  account): the account holder's **own place** is free when they're a library member (1.2); the people with them
  (guests, named or not) pay. Sam and two friends: `amount` 2000, `memberFree: true`. Sam alone: `amount` 0. A guest
  booking (no account) pays for every place. A guest who's a library member, on someone else's sign-up, pays through
  that sign-up (the brief: their guests pay); to get in free they sign up themselves or walk in.
- The monthly account limit and "Booked a session" (round 28's `track.value`) see the amount with the free place off.

### 1.5 At the door: checking in a sign-up

Entry is paid at the counter, so a sign-up at a members-free date is priced for who the account holder is **on the day**
when it's checked in: `POST /checkin` (the staff page), the POS's `/pos/checkin` and `/pos/checkin-member` (Add
everything to cart), Pay with cash's Got the cash (it checks in as the till does), and the floor's
`POST /bookings/:id/update` `{ status: 'attended' }`.

- Joined the library since they signed up: their own place comes off (`memberFree` becomes true), and the check-in's
  message ends `Library member: free entry.`, or `Library member: their own entry's free.` with others on it who pay.
- Their payment failed since: their own place goes back on, at what a place cost when they signed up (the event's entry
  now, when theirs was the only place), and the message ends with the failed-payment words above:
  `Checked in: Kiri Smith, 1 person for Library social. Charge $10.00. Their last library payment didn't go through, so entry isn't free today.`
- **Only while nothing's been paid, marked paid or waived on it.** One that's settled stays as it is: staff sort out
  anything owed back by hand, as for any refund.
- Checked in already: nothing changes. A changed price keeps a monthly account's open bill true (`reconcileBills`, as a
  staff change to a sign-up does).

**"I'm coming" taps never become check-ins.** They're counts for the calendar and the staff page (round 9's
interests), with no money on them, so nothing here changes them. A library member who tapped I'm coming is walked in at
the counter like everyone else.

### 1.6 Nothing to pay

A free entry is an amount of 0, as a free event's is: no line in the POS cart (`/pos/checkin-member`, `/pos/checkin`),
nothing in My Lair's `dueNow` or on a cash request, never owed after the day, never on a bill. It **stamps the loyalty
card** like any checked-in session (a walk-in is checked in), the same as a free card night's walk-in: the stamping
rules don't change. Like any free session, it isn't a first paid session for round 24's welcome codes.

The reminder two days before (round 29) of a sign-up whose own place is free says `On your tab: Nothing to pay`, not
the event's price.

### 1.7 What each view says

- `GET /events` (the staff Events tab): each event has `memberFree` (true or false, like `lockTables`), and so does its
  `config` (the event as `lair-config.liquid` writes it for the calendar).
- A sign-up as its member and staff see it (`joinView`, `staffJoinView`, so `GET /me` `joins`, `GET /floor` `joins` and
  the event views) and as a check-in row (`/checkin`, `/pos/scan`, `/pos/today`): `memberFree: true` when the account
  holder's own place is free. It's left out otherwise.

### 1.8 The staff Events tab: `POST /events`, `POST /events/:handle/update`

- `memberFree`: `true` or `false` (or `'true'` / `'false'`; anything else is `false`), written as `member_free`
  `"true"` or `"false"`, the way `lockTables` writes `lock_tables`.
- An update sends it only when it changes (the editor's "only what changes goes to Shopify"); a new event sent without it
  leaves the field empty (not free).
- After a write the Lair drops its cached events, as always, so walk-ins and sign-ups follow at once.

### 1.9 The website (not in this branch)

- The calendar reads events from the theme's `snippets/lair-config.liquid`, not from the Lair. To show "Free for library
  members" there, it needs `"memberFree": {% if event.member_free.value == true %}true{% else %}false{% endif %}` beside
  `lockTables`. Until then the event's price note says it ("Library members free, everyone else $10").
- The staff Events tab has no "Free for library members" box yet. Until it does, it's set in Shopify admin (Content ›
  Metaobjects › Lair event › Free for library members); the Lair takes `memberFree` from the tab already.
- The walk-in line on the staff page shows the Lair's message as it is, so the new words need nothing from the theme.

### 1.10 Storage

`event_joins.member_free` (INTEGER, NOT NULL, default 0), made sure of on every start (`MEMBER_FREE_COLUMNS`): 1 when
the account holder's own place is free as a library member. A sign-up's `amount` is what everyone else on it pays.

## 2. Games that stay in the Lair

### 2.1 Where the Lair learns it

A library game stays in the Lair when its Shopify product is tagged `In Store Only`, read the way the theme's product
page reads it: by the tag's handle, `in-store-only` (`inStoreTagged` in `src/core.js`; any case or spacing). The Lair
asks, in this order (`staysInLair`):

1. **Shopify's answer to the scan's own lookups**, kept 10 minutes: `LairVariantByCode` (a code the Lair hasn't seen)
   and the copies lookup `VariantCopies` (every scan, the desk's check-out and a hold marked collected), which now ask
   for the product's `tags`. So a tag added or taken off since the catalogue last synced counts at once.
2. Else **the catalogue** (`pick_catalog.in_store_only`, round 17), synced from Shopify's tags: only the listings that
   changed every 10 minutes, and all of them every 6 hours. Adding the tag changes a listing's `updatedAt`, so the next
   10-minute sync picks it up; it has had both games since 2 Nov.

Neither knowing the game, it goes home as before.

### 2.2 A member's scan: `POST /library/scan`

A game that stays in the Lair is never borrowed: **422**, nothing saved but the game itself (as any scan does), no plan
used.

- `Mechs vs. Minions (League of Legends) stays in the Lair, so it can't go home. Play it at your table instead.`
- With a hold on it: `Mechs vs. Minions (League of Legends) stays in the Lair, so it can't go home. It's on hold for you: collect it at the counter and play it at your table.`

One already at home with them (lent before 2 Nov) still answers `result: 'at-home'` first, saying to bring it to the
counter; staff check it in as any game.

### 2.3 The desk: `POST /library/loans` (staff, Library)

"Check out or lend a game" refuses it, to anyone (a member with a plan, one without, someone new), before anything's
saved: **422**

- `Mechs vs. Minions (League of Legends) stays in the Lair: it can't be lent. It's for playing at a table here.`
- With the member's hold on it: `… it can't be lent. Sam has it on hold: mark the hold Collected when you hand it over for a table.`
  (`They have it on hold` when the Lair has no name for them)

### 2.4 Holds: collected for a table, never a loan

Members can still reserve it (a hold is collected at the counter, to play here), as the product page says.

- **Staff mark it Collected** (`POST /library/holds/:id/update` `{ status: 'collected' }`): the hold ends `collected`, no
  loan is made, and the answer adds
  `notice: "Mechs vs. Minions (League of Legends) stays in the Lair: the hold's collected for a table, and nothing goes home."`
  (`loan: null`). My Library lists it under holds that ended lately ("You collected …"), not at home.
- **The member's own scan is refused** (2.2) rather than ending the hold. Why: scanning in My Library is for taking a game
  home, and the page treats any answer that isn't an error (or `at-home`) as borrowed: green, the sheet closes, "yours to
  take home". A refusal shows the Lair's words in the sheet with nothing new for the theme. Handing over a held game is
  the counter's job already, and Collected is where staff do it; it's how a table booking's game is handed over too
  (round 17: played there, never a loan).
- A hold nobody marks collected ends at midnight on its third day, as any hold.
- While it's being played, the Lair counts the copy as on the shelf again (no hold, no loan), so someone could reserve
  it for later that day; staff hand it on when the table's done.

### 2.5 Postal swaps: `POST /library/sends/:id/update`

`packed` or `sent` for a game that stays in the Lair: **422**, nothing changes:
`Mechs vs. Minions (League of Legends) stays in the Lair, so it can't be posted. Cancel this swap and refund any postage.`
`cancelled` works as before. The queue never holds one by post (it refuses to queue one, round 17), so this only meets a
swap from before the game's tag.

### 2.6 The last word

Whatever asks for it, a loan of a game that stays in the Lair is refused (`makeLoan` and `collectHold`, 422:
`Mechs vs. Minions (League of Legends) stays in the Lair, so it can't go home.`). The routes above say it first, in
their own words, before anything's written.

### 2.7 Unchanged

The queue still refuses it (422 `inStoreOnly`), a table booking can still have it on the table (round 17's booking
holds), Help me pick's borrow mode still weights it down, and its `GET /library/status` is as it was.

## 3. Messages, word for word

| Where | Words |
| --- | --- |
| Walk-in, a library member | `Library member: free entry.` |
| Check-in, a library member with others on the sign-up | `Library member: their own entry's free.` |
| Walk-in or check-in, a payment that didn't go through | `Their last library payment didn't go through, so entry isn't free today.` |
| The same, waiting on their bank's check | `Their last library payment is waiting on their bank's check, so entry isn't free today.` |
| Member's scan (422) | `<title> stays in the Lair, so it can't go home. Play it at your table instead.` |
| Member's scan, on hold for them (422) | `<title> stays in the Lair, so it can't go home. It's on hold for you: collect it at the counter and play it at your table.` |
| The desk (422) | `<title> stays in the Lair: it can't be lent. It's for playing at a table here.` |
| The desk, the member holds it (422) | `<title> stays in the Lair: it can't be lent. <First name> has it on hold: mark the hold Collected when you hand it over for a table.` |
| Hold marked collected (`notice`) | `<title> stays in the Lair: the hold's collected for a table, and nothing goes home.` |
| Postal swap packed or sent (422) | `<title> stays in the Lair, so it can't be posted. Cancel this swap and refund any postage.` |
| Any other loan (422) | `<title> stays in the Lair, so it can't go home.` |

The member's words are Gobgob's plain voice for an error (no "friend"); the rest are staff's.

## 4. Tests

`test/round30-library.test.js`, 18 checks named for the rules, each seen failing for the right reason before the change
and each rule broken once afterwards to see its check fail. `test/round7-b.test.js`'s `GET /events` check pins the
event's exact view and config, so it now expects `memberFree: false` in both (the new field, not a changed rule).

## 5. Going live

The Lair first, with Mo's yes (a push to `main` deploys it), before Board Game Night on Wednesday 11 November. Nothing
in the theme has to change for walk-ins or the library; the calendar and the Events tab's box (1.9) can follow.

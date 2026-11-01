# Lair API contract v29: roleplayers, loyalty and community, Phase 1

Round 29, from 2 November 2026. Mo approved the roleplayers, loyalty and community plan ("Roleplayers, loyalty and
community: the plan") on 2 November 2026. Phase 1, in November, is the head-start loyalty card, booking reminders and a
first game for beginners. This contract grows a part at a time: section 1 is the head-start card; booking reminders
(section 2) and a first game for beginners (section 3) follow.

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
  - After a roll, while the card has only Gobgob's 2 on it: "Card N is ready, and Gobgob's already started it."
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

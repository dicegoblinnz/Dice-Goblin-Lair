# Lair API contract v23-sure-ten: a loyalty roll taken as a sure $10

Round 23 (31 Oct 2026). From Mo, 30 Oct 2026, 11:59pm:

- "One thing to do for the dice goblin website is to make the rolling of the d20 have an option for someone to either
  get $10 store credit or roll a d20 and get store credit equal to the number they rolled. Make it a choice for the user
  if they feel their luck is bad."

The code: `src/core.js` (`LOYALTY_SURE`, `LOYALTY_PICKS`, `PICK_WORDS`, `loyaltySureMessage`) and `src/lair.js` (`roll`,
`loyaltyOf`, `prizeRow`, `prizeView`, `memberPrizes`, `rolledAs`, `ROUND23_COLUMNS`). The theme: `assets/my-lair.js`,
`lair-my.css`, `lair-staff.js`, `lair-demo.js`, `lair-core.js` and `sections/my-lair.liquid` (How it works). Tests:
`test/round23-sure-ten.test.js`, four shape checks in `test/lair.test.js`, and the browser check
`tools/qa/round23/sure-ten.mjs`.

## Why

- A d20 lands under 10 nine times in twenty, and on 5 or less a quarter of the time. Ten sessions for $2 stings, and
  the card is there to reward turning up. A sure $10 lets anyone who'd rather not risk it take fair value, and the roll
  stays for everyone who likes the gamble.
- It costs the shop nothing more. The faces 1 to 20 average 10.5, so a roll pays $10.50 on average and the sure $10 is a
  touch under it. Whatever people pick, a full card costs between $10.00 and $10.50, as before or a little less.

## 1. The pick

`POST /proxy/roll { kind: 'loyalty', pick }`, logged in:

- `pick: 'roll'`, no pick, or `null`: the d20, as before. The face is the prize, $1 to $20 store credit.
- `pick: 'sure'`: nothing is rolled, and the prize is `LOYALTY_SURE` (1000 cents) of store credit.
- Anything else (`'ten'`, `'SURE'`, `''`, a number, a list): 422 "That pick didn't come through properly. Try again.",
  before anything is used, rolled or paid.

Every roll is its member's pick, wherever it came from (a full card, a loot code, a birthday gift, staff): they're one
pool, and each is spent one way or the other. The pick travels in the request that spends the roll, so there's no face
to see first and no changing it after. Two taps at once, one each way, spend one roll: the second finds none left (409,
"No rolls yet, friend. Fill your card: 10 sessions earn a roll.").

The answer: `{ roll, kind: 'loyalty', pick, prize: { id, kind: 'credit', amount, status }, message, loyalty }`, with
`roll: null` for the sure $10. Its message: "You played it safe: $10 store credit is yours." When Shopify can't add the
credit, " Show this screen at the counter to claim it." follows, as on a roll's.

Logged out, any pick is still the home page's fun roll, never a prize (round 6).

## 2. The card says it's on offer

`loyalty` (GET /me, and the card the roll and "Got a code?" send back) adds `sure`: the store credit, in cents, any roll
can be taken as instead. A page offers Take $10 instead only when the card has it, so a theme that reaches customers
before the Lair app offers nothing the Lair can't do.

`loyalty.history` items add `pick`: `{ id, at, roll, pick, amount, status }`, with `pick: 'roll'` and the face, or
`pick: 'sure'` and `roll: null`. Prizes (GET /me `prizes`, a member's `pendingPrizes` on the staff page, and
`POST /prizes/:id/done`) add `pick` the same way. A prize with no roll row (none are made today) has `pick: null`.

## 3. Storage

`member_rolls.pick` (TEXT), made sure of on every start as round 15's columns are (no step in `MIGRATIONS`):

- null: the d20 was rolled (every row from before round 23 too);
- 'sure': the sure $10 was taken instead. Its `roll` is 0, since the column is NOT NULL and nothing was rolled.

The row's `kind` stays `loyalty`, so a sure $10 uses up a roll like any roll does. Its prize row is `source: 'loyalty'`,
`kind: 'credit'`, `amount: 1000`, and it's claimed in the database before Shopify is asked, as a roll's prize is.

## 4. When Shopify can't add it

As with a roll's prize: it's pending, the member shows the screen at the counter, and `STAFF_EMAIL` gets "Prize to give
at the counter: <name>", whose details say "Picked: Took $10 instead of rolling" where a roll's say "Roll: 14". Staff
mark it done with `POST /prizes/:id/done`.

## 5. The theme (built in the lab first)

- My Lair › Home: under "N rolls ready", the line "Roll for $1 to $20, or play it safe with $10." Under Roll your d20
  (gold) is Take $10 instead, the quieter ghost button: the d20 stays the main event, and the safe pick is in plain
  sight. Either button greys out both until the answer's back. Taking the $10 rolls nothing: the die rests on its 20,
  with no burst, and the coupon prints with a round $10 coin where the face would be. With rolls left, the next button
  says Roll your d20, not Roll again.
- My Lair › Wallet: the $10 has its coin, and "Played it safe · <day>".
- How it works (the section's default, which the live template doesn't override): "Feeling unlucky? Skip the roll and
  take a sure $10 instead. Your pick, every roll."
- The staff page: a member's prize to sort at the counter says "· took it instead of rolling".
- From the review: the page counts a tap as spent only when the answer is a loyalty one with its prize. A login that
  lapsed in an open tab gets the logged-out answer (just a fun roll, nothing paid), and the page now says "You've been
  logged out. Log in again to use your rolls." instead of printing it as a prize (a hole since round 6, on Roll your d20
  too).
- Demo mode works the same way (`pick: 'sure'`, `loyalty.sure`, each roll's `pick`).

## 6. Going live

The Lair app first: nothing changes for the theme that's live now, since no pick still means the d20 and the card's new
`sure` is ignored. Then the theme's files, through the preview to the live theme. The other order wouldn't break
anything (the page offers no $10 without `loyalty.sure`), but How it works would promise a $10 that isn't there yet.

## How to tell it worked

The share of rolls taken as the $10, from `member_rolls` (kind `loyalty`, `pick` 'sure' against null), and what full
cards cost on average against the $10.50 before. Alongside the brief's measures: regulars, and what people say at the
counter.

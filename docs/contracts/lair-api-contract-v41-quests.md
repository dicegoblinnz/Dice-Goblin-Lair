# Lair API contract v40: quests (round 41)

Mo, 16 November 2026: "I want to build a quest for my customers to help them get more stamps we can do a daily quest say
3 of them that refreshes daily a weekly quest maybe another 3 weekly and a one time quest etc. and have them be exciting
for customers to explore". The pool was settled with him the same evening (the plan doc, "Roleplayers, loyalty and
community: the plan", item 4 and item 7), with his answers: "Generous stamps it's $1 and if we can encourage more
spending we are winning", "Library membership is every month they renew and once they join too", "Gw dice don't count
but all of my dice especially the ones with buy 2 get 3 free you get a stamp per dice bought", "dice bought online earn
stamps too", "Bounty hunter down to 5", "Golden bounty once a week and that bounty once completed (daily bounty) you get
double stamps for it", "Last one out ... when they pay after 11:30pm no need to mention it but that is the condition",
and "4 riddles at a time so that if any gets sold we don't [waste them]".

Every quest is checked by the Lair from what it already sees (sessions, sales, library scans, membership bills, loyalty
rolls). Staff never tick anything. A quest pays loyalty stamps onto the member's card, like a session does.

## 1. Where the stamps live

A quest stamp is a row in the stamp ledger (`loyalty_stamps`, round 22) with `kind` `quest`, its quest's id in `note`,
the quest's name in `title` and a unique `key` (below). The card counts them like any ledger stamp (`stamp-quest` in
`stampTally`), so My Lair, the counter, the staff page, the booking emails and the cards-filled report all include them.

- A quest stamp is never "covered" by a day's sessions (as `stamp-staff` isn't), and never makes someone a returning
  player (`playedBefore`) or a paid session (`paidSession`).
- **Kept true.** `questSync` works out every stamp a member has earned and makes the ledger match: new ones are added,
  and one whose reason has gone (a refund, a booking staff undid, a loan or scan taken back) is taken back (`undone_by`
  `quest`). A quest stamp staff took back by hand stays taken back.
- It runs on GET /me (at most once a minute a member) and GET /me/quests, after a paid order, a library scan (a borrow
  or Playing it here), an invite code used and a member's code scanned at the counter.
- Rolls already rolled stay rolled, as with any stamp a session lost.

Keys: `dice:<order>:<line>:<unit>`, `library:join:<membership>`, `library:renew:<charge>`, `bounty:<kind>:<day>`, `weekly:<quest>:<week>`,
`once:<quest>`, `invite-friend`, `invite-bring:<friend>`, `gm-new:<player>`, `gm-back:<player>`, each prefixed with the
member's customer ID.

## 2. The quests

### Always on
| Quest | Stamps |
| --- | --- |
| `dice` | 1 for every die or set of Dice Goblin's dice on a paid order with the member on it, online or at the counter: every product in the dice deal's collection ("All dice (buy 2, get the 3rd free)") that isn't Games Workshop's, the free one included. At most 30 from one order line. |
| `library` | 1 for joining the library (each membership Lair Memberships made from a paid checkout), and 1 for every monthly renewal bill paid (`membership_charges`, kind `renewal`; a damage bill isn't one). |

### Daily bounties (once each a Lair day, 1 stamp; the day's golden one 2)
| Quest | Done when |
| --- | --- |
| `bounty-drink` | one paid sale with them on it has $6 or more of Drinks (product type) after discounts |
| `bounty-snack` | the same for Snacks |
| `bounty-icecream` | the same for Ice Cream |

**Golden bounty**: once a week the Lair picks one day and one of the three (crypto random, kept in `quest_weeks`). It
pays 2 stamps that day. GET /me/quests shows which one only on its day.

### Weekly quests (a Lair week runs Monday to Sunday; 1 stamp each)
Every week has Gobgob's riddle and two of the other four, picked at random when the week starts (`quest_weeks`).

| Quest | Done when |
| --- | --- |
| `riddle` | the week's riddle (section 4) is solved: the answer's box scanned in My Lair (to play here or borrow) from Monday 10am, with a stamped session or a paid counter sale of theirs in the same week |
| `full-house` | a table they booked for 3 or more stamps |
| `lair-dweller` | 3 stamped sessions |
| `bounty-hunter` | 5 daily bounties done |
| `clean-sweep` | all 3 bounties on one day |

### One-off quests (1 stamp each, once; counted since the loyalty card began)
| Chapter | Quest | Done when |
| --- | --- | --- |
| Wanderer | `first-scan` | their Goblin card is scanned at the counter (the till, or Shopify POS's tile) |
| | `first-ttrpg` | a TTRPG seat (or an RPG Session rung up for them) stamps |
| | `first-warhammer` | a Warhammer game table stamps |
| | `first-card-night` | a card night stamps (a sign-up to a card event, or a TCG League rung up for them) |
| | `first-table` | a table they booked stamps |
| | `first-paint` | they buy a Paint session (`LAIR-PAINT-SESSION`) |
| Storyteller | `first-gm` | a session they ran as GM stamps |
| | `three-systems` | TTRPG seats in 3 different systems |
| | `three-gms` | TTRPG seats with 3 different GMs |
| | `weekly-seat` | 4 stamped sessions of one weekly game |
| Librarian | `first-borrow` | their first library game goes home |
| | `ten-games` | 10 different library games picked up (borrowed, or scanned to play here) |
| Regular | `four-weeks` | a stamped session in 4 weeks in a row |
| | `eight-weeks` | the same, 8 weeks in a row |
| | `demand` | tell us what you'd play (off until the demand board is built) |
| | `discord` | link your Discord (off until Discord linking is built) |

A chapter is finished when every quest in it that's on is done; GET /me/quests then gives its title (Wanderer,
Storyteller, Librarian, Regular), for the Discord role and the Goblin card's badge.

### Secret quests (shown as ??? until done; 1 stamp each unless it says otherwise)
| Quest | Done when |
| --- | --- |
| `fresh-blood` | they buy a product listed in Shopify in the 30 days before |
| `rolled-it` | they buy the game the website's d20 picker rolled for them (the game or its shop twin), within 7 days |
| `ask-gobgob` | within 14 days of Library discovery's picks, they borrow, scan to play here or buy one of them |
| `fresh-pot` | their first paint: a Paints & Hobby product with Paint in its title |
| `fancy-pants` | a session in the Fancy room stamps |
| `first-table-gm` | they play at a GM's very first TTRPG session |
| `shelf-diver` | 3 different library games picked up in one week |
| `treasure-hunter` | 5 of Gobgob's riddles solved |
| `hoarder` | 100 different library games picked up: 10 stamps |
| `nat-20`, `nat-1` | a loyalty roll lands 20, or 1 |
| `grand-tour` | stamped sessions in every room of the Lair |
| `every-day` | a stamped session on each day of the week, over any stretch of time |
| `last-one-out` | they pay at the counter between 11:30pm and 4am. Never shown, even once found: its line says only "Found it". |

### Bring a friend
GET /me/quests gives each member their own invite code (`FRIEND-` and 6 letters and numbers, crypto random). A friend
types it under "Got a code?" in My Lair (POST /me/codes/redeem):
- only someone new (no session at Dice Goblin before today, as a welcome code), once ever, and never their own;
- when the friend's first paid session stamps, the friend gets 1 stamp (`invite-friend`) and the bringer 1
  (`invite-bring:<friend>`);
- not when a mobile number on the friend's bookings is one on the bringer's: GET /me/quests lists that friend as not
  counted.

### GMs
A GM (not on the team when they ran it) gets 1 stamp (`gm-new:<player>`) when a player's first-ever TTRPG seat is at
one of their sessions, and 1 more (`gm-back:<player>`) once that player has a second seat at one of their sessions.

## 3. Facts the Lair keeps

`quest_facts`, one row a fact, unique by `key`, undone rather than deleted:
- from a paid order (orders/paid, `questOrderPaid`): `dice` (a unit), `buy` (an order's Drinks, Snacks or Ice Cream,
  with its amount), `line` (each product line: product, flags `paint`, `fresh`, `paint-session`), `late` (a counter
  sale between 11:30pm and 4am). Product types, vendors, listing dates and the dice deal are asked of Shopify once a
  product and kept for a day (`quest_products`).
- `scan` (their code at the counter, a day), `play` (a library box scanned to play here, a game an hour), `rolled` (the
  d20 picker's game).
- A box scanned to play here counts only on a Lair day they were in (a session that stamps, or their code or a sale at
  the counter that day), and at most 5 different games a day: a shelf code typed at home is never a game played.
- Refunds: the 10-minute run asks Shopify, every 30 minutes, about orders with facts from the last 60 days; a refunded
  unit's `dice` is undone, and a `buy` is counted again on what's left. Then their quests are synced.

## 4. Gobgob's riddle

`quest_riddles`: one a week (`week`: its Monday), with its text, a hint, and its answer (a library game: product, title
and shelf code). Out from 10am that Monday. Riddles are written four at a time for Mo's OK (the first four are set up
on the Lair's first start, for the four weeks from the next Monday); staff with Members manage them:

- GET /quests/riddles (staff, Members): every riddle from last week on, oldest first: `{ riddles: [{ id, week, text,
  hint, answer: { productId, title, shelfCode }, solvedBy }] }`.
- POST /quests/riddles (staff, Members) `{ id?, week, text, hint?, code }`: a new riddle, or a change to one (`id`). `week`
  is a Monday (YYYY-MM-DD), one riddle a week; `code` is the answer's box (scanned or typed, as the library scan reads
  it). 422 when the week isn't a Monday, the text is empty or over 400 characters, or the code isn't a library game; 409
  when the week has one.
- POST /quests/riddles/:id/remove (staff, Members): a riddle nobody has solved yet comes off; 409 once someone has.

## 5. Routes

- **GET /me/quests** (logged in): `{ day, week: { key, from, to }, bounties: [{ id, name, done, stamps, golden }],
  weekly: [{ id, name, how, done, have, need }], riddle: { text, hint, out, solved } | null, chapters: [{ id, name, title,
  done, quests: [{ id, name, how, done, at, on }] }], secrets: { found: [{ id, name, how, at, stamps }], left },
  always: { dice, library }, invite: { code, brought, waiting, notCounted }, gm: { newcomers, returns }, stamps,
  loyalty }`. `stamps`: every quest stamp on their card; `loyalty`: their card, as GET /me has it.
- **POST /library/scan** `{ code, action: 'play' }` (logged in): "Playing it here". No plan needed, In Store Only games
  too, nothing goes home: `{ result: 'playing', game: { title, shelfCode }, riddle (true when it solved the week's
  riddle), message }`. A game they already scanned in the last hour answers the same and changes nothing.
- **POST /pick/rolled** `{ productId }` (logged in): the website's d20 picker landed on this game for them: `{ ok: true }`.
  10 a day a member.
- **POST /me/codes/redeem** `{ code }`: an invite code (above) → `{ kind: 'invite', message, loyalty }`.

## 6. Words

Every message a member or staff member can see is in `QUEST_WORDS` (src/quests.js), word for word.

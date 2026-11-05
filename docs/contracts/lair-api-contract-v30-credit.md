# Lair API contract v30: store credit

Round 30, 6 November 2026. Mo asked: "For dice goblin, I want the clients to have the ability to gift their store
credit to another. Also have the ability to add the gm store credit after every client is paid inside a game. So gms
are incentivized to keep the players inside the system and using Thier app to pay for things ... But also the store
credit are not updating properly ... Also the lair app inside the POS system needs to not have the option to add a
stamp as that is customer facing."

**Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Why the store credit wasn't updating: GM credit waited until a session was over (plus up to 10 minutes), and since 26
October 49 plain RPG Sessions were rung up at the counter (36 with nobody on the sale) against 29 seats paid through
the tile, so most seats were never marked paid and their GMs got nothing for them. A loyalty roll's credit also didn't
show in My Lair until the page was reloaded. Sections 2 and 3 fix what the Lair can; a sale with nobody on it can't be
matched to a seat, so the counter scans the player's code first.

## 1. Store credit gifts

A member sends some of their store credit to another member, by the friend's member code (on their Goblin card).
`src/credit-gifts.js`; tests `test/round30-credit-gifts.test.js`; browser check `tools/qa/round30-credit/credit.mjs`.

### 1.1 Routes

| Route | Who | What |
|---|---|---|
| `POST /proxy/me/credit/gift/check` | logged in | `{ code }`: who a member code is, before sending → `{ to: { name } }` (first name and initial, "Kai T."; nothing else about them) |
| `POST /proxy/me/credit/gift` | logged in | `{ code, amount, note?, key }` → `{ gift, balance, message, repeated? }`. `amount` in cents, $1 to $200. `note` up to 140 characters, one line (control characters and runs of spaces tidied). `key`: 8 to 64 letters, numbers, `-` or `_`, the page's own for this gift: the same key again gives back the first gift (`repeated: true`) and moves nothing. `balance`: the sender's store credit after it (cents), when Shopify said, else null |
| `POST /proxy/credit-gifts/:id/settle` | staff with Money | `{ outcome }`: what happened to a gift Shopify didn't confirm, as staff found it in Shopify admin: `sent` (it's on the friend's store credit, there or added by hand: both are emailed), `returned` (it's back on the sender's) or `failed` (nothing came off). Moves nothing → `{ gift }` (the staff view, 1.4) |

`GET /proxy/me` adds:
- `creditGifts`: their last 10 gifts, sent and received (received once it may have reached them: on their store
  credit, going on it now, or staff checking whether it went on it; never one Shopify turned away from them), newest first, each
  `{ id, direction: 'sent' | 'received', name, amount, note, status, at }`. `name` is the other side's ("Kai T.");
  `status` is `sent` (on the friend's store credit), `checking` (still with Shopify, or staff are checking), `failed`
  (nothing moved) or `returned` (it came off and went back: nothing moved in the end).
- `giftCredit`: `{ min: 100, max: 20000, left }`, `left` being what they can still send today (cents).

`GET /proxy/members/:customerId/credit` (Money) lists gifts in `history` beside the staff changes and damage charges,
newest first: `{ id: 'gift:<id>', giftId, kind: 'gift', amount (minus sent, plus received), note ("Gift to Kai T.: ..."
or "Gift from Mia C."), status: 'done' | 'pending' | 'failed', check, stage, balanceAfter: null, message, at, by: null,
from, to }`. `check: true` is a gift waiting for staff (1.3), with `stage` the change whose answer was lost. A friend's
page lists it the same way as their My Lair (above): a check about taking it off, or putting it back, is on the sender's
page only.

### 1.2 Limits

- $1 to $200 a gift; $200 and 5 gifts a sender a Lair day (gifts that didn't go don't count).
- One gift at a time: a sender with a gift still with Shopify gets a 409 until it's settled.
- 20 member codes looked up a member an hour (checking or sending), so nobody can trawl codes for names.
- Never more than their store credit: the Lair reads their balance from Shopify first when it can, and Shopify refuses
  to take off more than there is anyway (INSUFFICIENT_FUNDS).
- The sender is never told anything about the friend but their first name and initial.

### 1.3 How a gift moves

Every gift is a row in `credit_gifts`, written before Shopify is asked, so it never moves twice:

| `status` | What it means |
|---|---|
| `taking` | coming off the sender's store credit now |
| `giving` | it came off, and is going on the friend's now |
| `returning` | Shopify wouldn't add it to the friend's, so it's going back on the sender's now |
| `checking` | Shopify didn't answer while it came off: the 10-minute run looks in the sender's store credit (from 2 minutes after, allowing 2 minutes either side for the two clocks) and goes on to the friend's when it finds it there, or calls it `failed` after 30 minutes. Shopify unreadable for 2 hours: staff look (`check`, stage `take`) |
| `check` | Shopify didn't answer while it went on the friend's (stage `give`) or back on the sender's (`back`), so it may have. Never tried again by itself: staff get an email ("Check a store credit gift: Mia to Kai") and settle it on the member's page |
| `sent` | on the friend's store credit |
| `failed` | nothing moved |
| `returned` | it came off and went back: nothing moved in the end |

A gift left `taking`, `giving` or `returning` for 30 minutes (the Lair restarted mid-call) counts as an answer lost.
Each change gives up after 20 seconds as a lost answer. Shopify's store credit has no idempotency key, which is why a
lost answer is looked for (taking) or handed to staff (giving and returning) rather than tried again.

A gift that reached the friend emails both, once: the friend "Mia sent you $10.00 of store credit" (with the note), and
the sender a receipt ("You sent Kai $10.00 of store credit", with "Didn't send this? Reply to this email straight away
and the team will look into it."). Shopify's own store credit email isn't sent for a gift (`notify: false`).

### 1.4 The staff view

`{ id, from: { customerId, name }, to: { customerId, name }, amount, note, status, stage, message, at, sentAt,
settledAt }`.

### 1.5 The words

`CREDIT_GIFT_WORDS`, word for word (`$` amounts as `$12.50`):

| Key | Status | Words |
|---|---|---|
| `login` | 401 | Log in to send store credit. |
| `noAccount` | 404 | Open My Lair once first, then try again. |
| `code` | 422 | Type your friend's member code, like SJ-OWLBEAR-17. It's on their Goblin card in My Lair. |
| `noMember` | 404 | There's no member with that code. Check it with your friend. |
| `own` | 409 | That's your own member code. Pop in your friend's instead. |
| `amount` | 422 | Send between $1 and $200 at a time. |
| `note` | 422 | Keep the note to 140 characters. |
| `key` | 422 | That didn't come through properly. Try again. |
| `daily(left)` | 409 | You can send $X more today. / That's all the store credit you can send today. More can go tomorrow. |
| `count` | 409 | That's 5 gifts sent today. More can go tomorrow. |
| `busy` | 409 | Your last gift is still on its way. Try again in a few minutes. |
| `lookups` | 429 | That's a lot of member codes in a row. Try again in an hour. |
| `off` | 503 | Store credit can't be sent right now. Try again in a minute. |
| `short(balance)` | 409 | You have $X of store credit, so you can send $X at most. / You don't have any store credit to send right now. |
| `shortNow` | 409 | You don't have that much store credit. Check your balance and send less. |
| `notTaken(why)` | 409 | Shopify didn't take the store credit off your account (why). Nothing moved. Try again in a minute. |
| `returned(first)` | 409 | Shopify wouldn't add it to Kai's account, so it's back on yours. Nothing's changed. |
| `backCheck(first)` | 200 | Shopify wouldn't add it to Kai's account, and hasn't said it's back on yours yet. The team's checking, so nothing goes twice. |
| `sent(amount, first)` | 200 | Sent! $10.00 is on Kai's account now. |
| `checking` | 200 | Shopify didn't answer, so Gobgob's checking whether it went. It shows here within 10 minutes. |
| `onItsWay(first)` | 200 | It came off your store credit, but Shopify hasn't said it reached Kai yet. The team's checking, so it's never sent twice. |
| `gone` | | Shopify has no record of it coming off, so nothing moved. (a gift's message, once it's failed) |
| `notCheck` | 409 | That gift isn't waiting to be checked. |
| `outcome` | 422 | Say what happened: sent, returned or failed. |

## 2. GM credit as each player pays

From Mo: "add the gm store credit after every client is paid inside a game". Sessions from 26 October 2026 on, as
round 21, with its rules (a staff GM's still follows the team's setting; a free session, a $0 fee, a $0 seat and a seat
the GM pays for give nothing). `src/gm-credit.js`, `src/counter.js`; tests `test/round30-gm-credit.test.js`.

- **When:** once a session has started, each seat's GM fee goes to its GM as soon as the seat is paid, without waiting
  for the 10-minute run: a background run starts right after a payment lands (staff marking it paid, the tile's line
  through Pay on Verifone or Shopify POS, a plain RPG Session (2.1), cash, a tab paid). A seat paid before the session
  starts goes when it starts (the 10-minute run, and the first payment after). It was: within 10 minutes of the end.
- **Cancelled after the GM had it:** a session cancelled, or a seat cancelled, marked a no-show or not paid any more,
  after its fee went to the GM: staff get an email ("... got $5.00 GM credit for Mia's seat, but that seat was
  cancelled. If Rangi shouldn't keep it, take it off their store credit on their member page."). Nothing is taken back
  by itself, as round 21.
- **Shopify said no:** a seat is tried again 10 minutes later at the soonest (`GM_CREDIT.retryAfter`), 5 tries in all,
  however many payments start runs meanwhile, so a busy Shopify can't use the tries up in a couple of minutes. Session
  done tries again at once.
- **Session done** (`POST /games/:id/credit`) before a session from 26 October has started: 409 `notStarted`.
- `GET /me` `games` (the sessions they run) add `gmCreditEach`: what the GM gets for each person who pays, in cents
  (the fee; 0 for a free session, a $0 fee, a session from before 26 October, or a staff GM the team's setting keeps it
  from). On a session whose GM credit adds itself, each of `players` adds `gmCredit`: `credited` (on the GM's store
  credit), `coming` (paid, and on its way: the session hasn't started, a run has it now, or Shopify's still to say or
  staff add it by hand) or null (not paid, or none for that seat).
- The GM's emails' "Your credit" line (`gmCreditLine`): "$5.00 store credit for each paying player, as they pay". The
  invite email: "Your store credit goes onto your account as each player pays through the Lair."
- **One email a session** (Mo, 6 Nov 2026: "One email for all the players per session"): the credit that adds itself
  goes on with `notify: false` (`creditCustomer`'s option), so Shopify sends the GM nothing for each player, and the
  seat is marked `quiet`. An hour after the session ends (`GM_CREDIT.mailAfter`), the 10-minute run
  (`gmCreditMails`) emails each GM once for it: who paid and the total on their store credit (below). Nobody paid by
  then (players on a monthly account pay with their bill): it goes once some credit lands. Seats that land after the
  email do so quietly (it says so), and show in My Lair's Games I run. Only seats credited quietly count. None for a
  session with no credit, a staff GM's the setting kept, one where none of the credit landed in the last 48 hours
  (`GM_CREDIT.mailWithin`: email that was off for days doesn't send about old sessions), or one whose GM had credit
  for it with Shopify's email (before this went live), so an email never tells half the story. Each email is claimed
  in `gm_credit_mails` before it goes, with the idempotency key `gm-credit-mail-<game>-<GM>`: Resend down, busy or not
  answering in time (5xx, 429, a timeout): unclaimed, and the next run tries again; a claim left with no answer for 30
  minutes (`GM_CREDIT.mailStale`: the Lair restarted mid-send) is tried again with its same key; anything else Resend
  refuses, or no address for the GM: not tried again (logged). Up to 20 a run. The maintenance answer adds
  `gmCreditMails: { sent, retry, failed }` when it looked at any. Session done on a session from before 26 October
  (staff add that GM credit themselves) still goes with Shopify's email.

The email (Gobgob signs it; the button opens My Lair at Games I run, `?view=ml-games`):

| Part | Words |
|---|---|
| Subject (`mailSubject`) | Your GM credit for Rangi's one-shot: $15.00 |
| Title (`mailTitle`) | Thanks for running Rangi's one-shot! |
| Intro (`mailIntro`) | Kia ora Rangi, $15.00 of store credit is on your account for Rangi's one-shot: $5.00 for each of the 3 players who paid. (one: "$5.00 for the 1 player who paid"; fees that differed: "for the 3 players who paid") |
| Details | Session (when), Players who paid ("Mia (2), Kai": first names, people on the seat in brackets; past 8, "and 3 more"), Store credit |
| After (`mailLater`) | Anyone who pays later still sends you their $5.00. It lands on your store credit without an email, and My Lair shows it under Games I run. |
| Button | See it in My Lair |
| Sign-off | Happy GMing! Gobgob |

`GM_CREDIT_WORDS` changes, word for word:

| Key | Words |
|---|---|
| `notStarted` (was `notOver`) | GM credit adds itself for this session: once it's started, the GM gets their fee as each player pays. There's nothing to tap. |
| `markedOff` | Marked: they weren't working, so they get their GM credit as their players pay. |
| `unpaid` | isn't marked paid any more |
| `noShow` | was marked a no-show |
| `cancelled` | was cancelled |

### 2.1 A plain RPG Session at the counter pays the player's seat

A counter sale (Pay on Verifone or Shopify POS) of the Session product's RPG variants (SKU `LAIR-SESSION-RPG`, or
`LAIR-SESSION-RPG-` and more, like `-KIDS`), with a customer on the sale, pays that customer's unpaid TTRPG seats that
start on the sale's Lair day, soonest first: each unit pays one person, what the unit paid after discounts, up to what
the seat has left (anything over isn't the seat's). Not a seat that's paid, waived, cancelled, a no-show, on a free or
cancelled session, one its GM pays for, nor one in a session the customer runs. At most 10 units a line. Each is a
payment row with line id `<line>:seat-<n>`, so Shopify sending the order again pays nothing more. `POST
/internal/orders-paid` answers `sessionsPaid: [refs]` when any were. The sale's stamp and the seat's are the same
session: one stamp that day. Scan the player's code first, so they're on the sale.

## 3. Store credit shows straight away

- `POST /proxy/roll` (`kind: loyalty`) adds `balance`: the member's store credit after the prize, in cents, when
  Shopify said it (left out otherwise, and when the prize is waiting at the counter). `creditCustomer` asks Shopify for
  `balanceAfterTransaction` and returns it as `balanceAfter`; a denied field still counts as made.
- A gift's answer carries the sender's `balance` the same way (1.1).
- My Lair shows a new balance at once everywhere it's on the page (the Wallet's card, Home's summary, a monthly
  account's panel). The page's balance is Shopify's, drawn by Liquid when it loads.

## 4. No stamps at the counter

The POS tile faces customers, and some were tapping Add a stamp for themselves (each paid or checked-in session adds its
own). The tile has no Add a stamp or Undo that stamp any more, and `POST /pos/stamp` and `/pos/stamp-undo` answer 410:

> Stamps aren't added or taken back at the counter any more: each session adds its own once it's checked in or paid.
> Staff change stamps on the staff page, under Members.

Stamps the counter added before stay, and staff can take any back on the member's page. The staff page's check-in card
keeps its Add a stamp (two a member a day); its daily limit's words: "That's 2 stamps added at check-in for them today.
Any more go on the staff page, under Members."

## 5. Code

One more guard (`test/round30-mixins.test.js`): no module mixed into the Lair (`Object.assign(Lair.prototype, …)`) may
have a method name the Lair already has. The gifts' first `giftRow` replaced the birthday gifts' own that way; the
check also found round 11's `memberForEmail` replacing lending's copy (the copy that never ran is gone).

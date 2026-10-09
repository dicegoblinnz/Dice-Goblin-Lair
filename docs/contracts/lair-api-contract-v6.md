# Lair app API: round 6, part 1 (5 Oct 2026)

**Changes only.** This round sits on top of `lair-api-contract-v5.md` (with its v5.1 additions), then v4, v3 and the base contract. Where they disagree, this file wins. Money is in cents, times are milliseconds since 1970 (UTC), and days are Auckland days (the Lair's time zone) unless a field says otherwise.

**Where things live:**
- Backend: `main` of dicegoblinnz/dice-goblin-lair at db8702b (deployed). Round 6 work goes on branch `round6`.
- Theme: `dice-goblin-2-theme` of dicegoblinnz/Dice-Goblin-website at 53a9c56 (on the preview 166589005927). Round 6 theme work goes on `r6-*` branches.
- The theme's demo backend is `assets/lair-demo.js` (`window.LairDemo` factory, demo mode only); the live client is `LiveBackend` in `assets/lair-core.js`. Every route below needs both.

Mo's words are quoted where they set a rule.

---

## 1. Loyalty card (replaces the spend dice)

> "a dice given when you complete the 10 session card … whatever you roll is the store credit you add to your account. Simple as that."

### Rules
- **A stamp per person per session they turn up to.** A session is any booking or sign-up that is checked in: a table booking, a TTRPG seat, an event sign-up (TCG nights included), an event game spot. Buying products never earns stamps.
  - Bookings and seats count once their status is `'seated'` or `'done'` (left). Event sign-ups count once `'attended'`. `'noshow'`, `'cancelled'` and `'held'` never count. Undoing a check-in takes its stamps away again.
  - Only sessions that start on or after the loyalty start count. The first start of round 6 writes meta key `loyalty-from` (like round 5's `owed-from`).
- **Who gets it:** the account the booking or sign-up belongs to (`customerId`) gets one stamp for each of its `people`. Mo: "if you or a friend paid for your session then you get it, if you don't have an account the payer can get it themselves." Friends without an account are counted on the booker's card. A seat staff added for a member (its own booking, linked to them) is that member's. A walk-in or guest booking with no account earns nothing until it's linked to one (section 5 links guest seats by email).
  - Paying for someone else and choosing whose card gets the stamp is part 2 (pay for others).
- **The card:** 10 stamps fill it. A full card gives one roll, and the next stamp starts a new card.
- **A roll** is a d20 (crypto random). Its face is the prize: $1–$20 store credit, added to their Shopify store credit at once (`storeCreditAccountCredit`, as the old dice did). If Shopify refuses, it becomes a pending prize for the counter, exactly as before.
- **Other rolls:**
  - **Welcome:** one roll, once per member, the first time they have a member record after the loyalty start (everyone who already has one gets theirs on their next visit).
  - **Birthday gifts:** round 5's gift `rolls` are loyalty rolls now.
  - **Staff:** staff can give any member extra rolls (section 1, staff routes).
- **Nothing carries over.** Mo: "this system is new so we don't need to replace anything." Rolls earned from spend under the old dice don't count. Old pending prizes stay on the staff page until marked done.
- The spend dice retire: `POST /roll` with `kind: 'spend'` or `'bonus'` answers 410: "The spend dice have retired. Fill your loyalty card: 10 sessions earn a roll." `POST /roll` with no kind (the home page's fun roll) is unchanged.

### Member routes
- **`GET /me` adds `loyalty`:**
  ```
  loyalty: {
    stamps,            // 0–9: stamps on the current card
    cardSize: 10,
    cards,             // full cards so far
    rolls: { available, earned: { cards, welcome, birthday, staff }, used },
    recent: [ { at, title, people } ],   // the last 10 stamped sessions, newest first ("Table T4", a game's title, an event's title)
    history: [ { id, at, roll, amount, status } ]  // the last 20 loyalty rolls, newest first; status 'added' | 'pending'
  }
  ```
  `rolls` (the old field) stays for old clients and mirrors loyalty: `{ available: loyalty.rolls.available, toNext: null, per: null, bonus: loyalty.rolls.available }`.
- **`POST /roll { kind: 'loyalty' }`** (logged in): 409 "No rolls yet, friend. Fill your card: 10 sessions earn a roll." when none are available. Otherwise:
  ```
  { roll, kind: 'loyalty', prize: { id, kind: 'credit', amount, status: 'added' | 'pending' }, message, loyalty }
  ```
  `message`: "Natural 20! $20 store credit is yours." for 20, "A 1! $1 store credit, and Gobgob's still proud of it." for 1, otherwise "You rolled a N: $N store credit is yours." When pending, add " Show this screen at the counter to claim it."

### Staff routes
- **`POST /members/:customerId/rolls { count, note? }`** (staff; count 1–20): gives extra rolls. Returns `{ member }` (the GET /members view below).
- **`POST /members/:customerId/since { since }`** (staff): when they became a customer. `since` is `'YYYY-MM-DD'`, `'YYYY'` (taken as 1 January) or `null` to clear. Returns `{ member }`.
- **`GET /members` items add:**
  - `loyalty: { stamps, cards, rollsAvailable }`
  - `customerSince`: `'YYYY-MM-DD'` or `null` (staff-set)
  - `yearsWithUs`: whole years since `customerSince`, or else since their Shopify account was created, or else since the Lair first saw them; at least 0.
  - `spendFy`: spend in the current financial year to date (1 April to 31 March).
  - The old `rollsFromSpend`, `rollsGifted` and `rollsUsed` stay, from the old dice (staff history only).
- **`GET /members/birthdays`**: `suggested` adds `rolls: max(1, yearsWithUs)`. Mo: "every year you have supported dice goblin you get a dice to roll." The staff page fills the gift form's rolls with it; staff can change it.
- **POS member view** (`/pos/scan` member and `/pos/member`): adds `loyalty: { stamps, cardSize, rollsAvailable }` for display only.

**Implemented** (backend, branch `r6-backend`). Notes and deviations:
- Stamps aren't stored. They're counted from the bookings (`table`, `walkin` and `gm-seat`; event game spots are table bookings) and sign-ups every time they're read, so undoing a check-in takes them back and nothing can drift. For staff to undo one, setting a seated booking back to `'confirmed'` now also clears its `arrivedAt`, and `POST /bookings/:id/update` on a sign-up takes `status: 'confirmed' | 'attended'` from staff (it took only paid and refunded before).
- Welcome and staff rolls are rows in a new `loyalty_grants` table (who gave them, the note); a unique index keeps the welcome roll to one. It's given whenever the Lair records a member: GET /me, a booking, the profile form or a hold.
- `earned.birthday` counts the `rolls` on every birthday gift, round 5's included, as this section says. `used` counts loyalty rolls only, so a round 5 gift roll that was already rolled on the old dice can be rolled again (round 5 went live today, so that's a few rolls at most).
- `message` says "an" before 8, 11 and 18 ("You rolled an 8: $8 store credit is yours."), as the loyalty theme branch does.
- `POST /roll { kind: 'daily' }` (a 410 since round 4) now gives the loyalty card's words: "The daily roll has retired. Fill your loyalty card: 10 sessions earn a roll." Logged out, every kind (`loyalty` too) is just a fun roll, as before.
- `history[].id` is the prize's id. A pending prize that staff have since marked done shows as `'added'`, since it's been given.
- Prizes are saved with `source: 'loyalty'` before Shopify is asked. A refused credit emails `STAFF_EMAIL` and lists under the member's pending prizes, as the old dice did.
- The staff routes answer 404 "No member with that customer ID." for someone the Lair hasn't seen. Bad input is a 422: "Give between 1 and 20 rolls.", "Say when they became a customer, like 2019-06-01 or 2019 (or null to clear it).", "Pick a real date, like 2019-06-01, or just the year, like 2019." or "That date hasn't happened yet. Pick when they first became a customer."
- `yearsWithUs` from the Shopify account: before answering, GET /members asks Shopify (`read_customers`, one call) when up to 100 members' accounts were made (the most recently seen whose date isn't known yet), and GET /members/birthdays does the same for the birthdays it lists. Each answer is kept (`members.shopify_since`; 0 when Shopify has none, so it isn't asked again). A failed lookup waits 10 minutes.
- In the POS answers, `loyalty` sits at the top level, beside `member`, `rows` and `passes` (`/pos/scan` for a member, and `/pos/member`). `/pos/member`'s round 3 `rolls` mirrors the loyalty rolls, like GET /me's. The POS extension shows the card under the member's name: "Loyalty card: 7 of 10 stamps · 1 roll waiting in My Lair".

## 2. Spend by month and financial year

> "I want it to be able to be broken down monthly and yearly, and try to follow the financial year."

- **`GET /members/:customerId/spend`** (staff):
  ```
  { months: [ { month: 'YYYY-MM', amount, orders } ],     // the last 24 months, oldest first, months with nothing included as 0
    years:  [ { fy: '2026/27', from: '2026-04-01', to: '2027-03-31', amount, orders } ],  // up to the last 4 financial years, newest first
    total, since: 'YYYY-MM-DD' | null }                 // since: the first order the Lair knows about
  ```
- Source: the Lair's own `spend` table (orders/paid). If it can, the backend also fills in older orders for that customer from Shopify (orders query by customer; `read_all_orders` when granted, otherwise Shopify's last 60 days), once per customer, idempotent by order id. Say which in the code; never double-count an order.

**Implemented.** Notes:
- Months and financial years are Lair days (Pacific/Auckland). `years` runs from the current financial year back to the year of the first order, at most 4; `total` is everything.
- The backfill runs the first time staff open a member's spend: `customer.orders` (100 a page, at most 10 pages), paid orders only (paid, partly refunded or refunded, and not cancelled), counted at the subtotal after discounts and before returns, dated when processed. That's the same "no clawback" rule as orders/paid. Each order is added only if its id isn't in `spend` already, and orders/paid adds nothing for an order the backfill added (both use the order's id). The new `spend_backfills` table remembers who was filled in and how far back: `recent` (Shopify's last 60 days, with `read_orders`) or `all` (`read_all_orders`, when the store has granted it). A member filled in with `recent` is filled in again once `all` is granted. Two lookups at once share one; a failed one waits 10 minutes, and the report still comes back with what the Lair has. The backfill also keeps when their Shopify account was made (for `yearsWithUs`).
- `read_all_orders` isn't in `pos-app/shopify.app.toml`: Shopify grants it only on request (the app's API access requests → Read all orders), so Mo decides whether to ask. If it's approved, add it to the toml's scopes. Until then the backfill sees 60 days.

## 3. Session gifts

> "sell session gift bundles where people can gift the receipt to someone and have them redeem it"

- **Store setup (coordinator):** product "Session gift", variants "5 sessions" $50 (SKU and barcode `LAIR-GIFT-5`) and "10 sessions" $100 (`LAIR-GIFT-10`). Draft until the backend is live.
- **orders/paid:** a paid line whose SKU matches `/^LAIR-GIFT-(\d{1,3})$/i` issues `quantity` **unlinked** passes of N sessions each, whoever bought it:
  - `label` "Gift: N sessions", `source: 'gift'`, `orderName`, `cover` the table price, `pricePaid` as for passes, holder name `null`, note "A gift from <buyer's first name>" when known.
  - Idempotent per (order, line, unit), as for passes.
  - **Email the buyer** (the order's email): "Your session gift is ready". One block per code: the code in big letters, "N sessions at the Dice Goblin Lair", and how to redeem: "Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under 'Got a pass code?'". No email address on the order: staff get the codes instead.
- Redeeming is the existing `POST /me/passes/claim { code }`. A claimed gift becomes theirs (`source` stays `'gift'`).
- Every pass view: `source` can be `'gift'`. Member views show "A gift" for it.

**Implemented.** Notes:
- Gift codes start `DG-` (there's no holder's name to take initials from), like any pass made without a name. The holder's name is stored as null; staff views show `holder: { customerId: null, name: '', email: '' }`, as for every pass with no holder.
- Up to 100 units a line, and `pricePaid` is the unit's price after the line's discounts, as for `LAIR-PASS-N`. A gift line makes no ordinary pass, and the order still counts for the buyer's spend. orders/paid's answer adds `gifts`: the codes it made.
- The buyer's email and first name come from the order (`order.email`, else the customer's email; the customer's or billing first name), asked only while gift passes are still to be made. That's protected customer data (Name and Email), the same approval round 5's passes asked for. If Shopify won't say, a member on the order fills in what the Lair knows. With no email at all, or if sending to the buyer fails, `STAFF_EMAIL` gets the codes ("Session gift codes to pass on: #1234").
- The buyer's email: subject "Your session gift is ready" (the heading says "gifts are" when there are several codes). Each code in its own box, with "N sessions at the Dice Goblin Lair" and the redeem line, then a line saying each session covers one person's table fee (up to the table price).
- A member's view of a claimed gift has `source: 'gift'`, `orderName: null` and no `note`: notes are for staff, as on passes staff make.

## 4. Library holds (reserve a board game)

> "a button to reserve a boardgame … let us know that this happened and we will hold it for 3 days by 12pm on the third day. If they don't pick it up it automatically goes back on the shelf. And if anyone tries to book it out other than the user it registers as reserved and you need to wait …"

### Rules
- **Who:** logged-in library members. Their plan comes from their Shopify customer tags (Simplee), matched without case: a tag containing "hoard" → 5 games, "stash" or "treasure" → 3, "grab" or "loot" → 1; a plain `library-member` tag with none of those → 1. No plan → 403 "Join the library to reserve games."
- **Limit:** their active holds can't pass their plan's games (part 2 adds games already at home to the count).
- **Copies:** the variant's inventory quantity in Shopify, read with the new `read_products` and `read_inventory` scopes (added to `pos-app/shopify.app.toml`; Mo approves them once in Shopify admin). Until they're granted, or if the lookup fails, the `copies` the page sends (1–10) is used, and failing that 1. Cache a variant's copies for 10 minutes.
- **Available** = copies − active holds (part 2 also takes away copies out on loan).
- **How long:** until 12pm (Lair time) on the third day after the day it's made: made any time Monday, held until 12pm Thursday. Constants `HOLD_DAYS = 3`, `HOLD_UNTIL_HOUR = 12`.
- **Statuses:** `'held'` (active), `'collected'` (staff handed it over), `'cancelled'` (by the member or staff), `'expired'` (not collected in time), `'released'` (staff put it back early).
- **Maintenance** (the 10-minute cron): a `'held'` hold past its `until` becomes `'expired'` and the member gets an email: "Your hold on <title> ended, so it's back on the shelf. Reserve it again any time."

### Routes
- **`GET /library/status?ids=<variantId>,<variantId>…`** (anyone; at most 60 ids): 
  ```
  { games: { [variantId]: { copies, held, available, nextFree, mine } } }
  ```
  `nextFree`: when nothing is available, the earliest `until` among its active holds (ms), else `null`. `mine`: `{ id, until }` when the logged-in member holds a copy, else `null`. Ids the Lair has never seen come back with `copies` from Shopify (or 1), `held: 0`.
- **`POST /library/holds { variantId, productId, title, shelfCode, handle, copies? }`** (member; staff may add `customerId` to reserve for someone, with no plan limit):
  ```
  { hold, holds }   // hold: { id, variantId, productId, title, shelfCode, handle, until, status, createdAt }; holds: their active holds
  ```
  Errors: 401 "Log in to reserve a game."; 403 (no plan, above); 409 "Your plan has N games at a time, and you've got N reserved. Collect or cancel one first."; 409 "Every copy is reserved right now. It's back on the shelf by <weekday time> if nobody collects it." (also when they already hold this game: "You've already reserved this one, friend. It's held until <when>.").
  Emails: staff ("Hold this game: <title> (<shelf code>) for <name>, until <when>", with the member's code and email) and the member ("<title> is on hold for you until <when>. Collect it at the counter with your member code.").
- **`POST /library/holds/:id/cancel`** (the member who made it, or staff) → `{ hold, holds }`.
- **`GET /library/holds?status=active|all`** (staff): `{ holds: [ { ...hold, customerId, name, email, code (member code), staffNote } ] }`, active ones soonest `until` first, `all` the last 200 newest first.
- **`POST /library/holds/:id/update { status: 'collected' | 'released' | 'held', note? }`** (staff) → `{ hold }`. `'held'` puts back a hold that was released or expired by mistake, with a fresh `until`.
- **`GET /me` adds `holds`:** their active holds, soonest first, plus any that ended in the last 3 days (so My Lair can say "your hold ended").

**Implemented.** Notes and deviations:
- The plan comes from the customer's Shopify tags the Lair already reads for staff and GMs (kept up to 5 minutes, so a new plan counts within 5 minutes). Staff reserving for someone need no plan for them: 404 "No member with that customer ID." if the Lair hasn't seen them.
- **Copies:** a variant Shopify doesn't track, or shows with no stock, counts as unknown rather than 0 copies, and the page's copies are used (then the copies a page last sent with a hold, then 1). Library copies aren't for sale, so their stock may well be 0 or untracked, and 0 copies would make them impossible to reserve. A refused lookup (the scopes not approved yet) isn't tried again for 10 minutes.
- More than 60 ids is a 422: "Ask about up to 60 games at a time." A hold needs a variant id and a title: 422 "Pick a game from the library to reserve."
- A hold that's past its `until` counts as `'expired'` everywhere straight away (status, views, the copy is free), before maintenance gets to it. Maintenance then stores it, sets `endedAt` to its `until` and sends the email once.
- Hold views add `endedAt` (when it was collected, cancelled, released or expired; null while held). In messages `<when>` reads "Thu 8 Oct, 12pm", as the library page shows it, and in emails "Thursday 8 October, 12pm"; `<weekday time>` is "Thu 12pm". "1 game at a time" is singular.
- Staff reserving a game the member already holds: 409 "<name> already has this one on hold, until <when>."
- Cancelling: 401 "Log in to manage your holds.", 404 "That hold could not be found.", 403 "That hold isn't yours to cancel.", 409 "That game's been collected already." or "That hold has already ended." Cancelling one that's already cancelled answers it as it is. Staff get staff views back.
- Updating: 422 "A hold can be marked collected, released or held again." `note` is up to 300 characters.
- The member's emails go to the email in their Lair profile; with none, only the staff email goes. The expiry email has a "Reserve it again" button to the game's page.

## 5. Joining a TTRPG session without an account

> "have someone join a game by getting a QR code generated for them … it basically just emails the gm that a new person joined and their details inside the form and they will be charged when they arrive. Simple as that."

- **`POST /bookings { kind: 'gm-seat', gameId, name, email, phone?, people, players?, notes? }` works without logging in**, for any session that's open, including a single session of a weekly series. "Save my seat every week" (`POST /games/:id/join-series`) still needs an account, because their member code is the ticket.
  - The same rules as members otherwise: seats, seats held for regulars, the 6-upcoming-per-email limit, the per-client rate limit.
  - `name` and a valid `email` are required; `phone` is optional (up to 30 characters).
  - The response is as today: the booking with its `ref`, the ticket code the QR shows.
- **Every new player emails the GM** (`gmEmail`): a guest, a member, a weekly regular's first seat, or a player staff add. Subject "New player for <title>, <when>: <name>". Details: name, email, phone (if given), seats, players' names and characters, notes, "They pay at the counter when they arrive", and the seats left. No GM email on file: staff get it. Seats that maintenance rolls forward for regulars don't email the GM.
- **The guest's confirmation email** adds: "Make an account with this email any time, and your seats will show up in My Lair."
- **Guest seats join their account:** on `GET /me`, bookings and event sign-ups with no `customerId` whose email matches the logged-in member's email (ignoring case), and that are upcoming or ended in the last 30 days, get the member's `customerId`. Stamps then follow (section 1).

**Implemented.** Notes and deviations:
- Errors as for members: 422 "Add your name.", "Add an email so we can send your confirmation.", "That phone number looks too long. Keep it to 30 characters." `notes` (up to 500 characters) is kept with the seat. A guest seat has no `customerId`.
- The GM's email: "New player for <title>, <when>: <name>", with Name, Email, Phone, Seats, Players (names and characters), Notes, When and "Seats left: N of M" (after this seat), then "They pay at the counter when they arrive." Replies go to the player. Staff adding a player and a weekly regular's first seat send it too; seats maintenance rolls forward don't. With no GM email it goes to `STAFF_EMAIL`, saying there's no email on file for the GM.
- The "Make an account …" line goes on any seat's confirmation with no account: a guest's, or a seat staff added for someone who isn't a member.
- **Matching is on the member's verified Shopify account email, not "the member's email".** The email in a Lair profile is typed by the member, so matching on it would let anyone type someone else's email and take their bookings. On GET /me the Lair asks Shopify for the customer's `defaultEmailAddress` and uses it only when `verifiedEmail` is true (at most once a day a member, kept in `members.account_email`; a refused lookup waits 10 minutes). It needs the Email field of protected customer data, which round 5 already asked for. It doesn't change the email in their Lair profile. The table a GM's game holds (a `gm` booking) never moves.

## 6. Calendar sub-categories

> "a sub category for TCGs and TTRPGs so that they can be filtered"

- **Events made in the Lair app** (staff page) take an optional `game` (up to 40 characters, like "Magic: The Gathering", "Pokémon", "Riftbound"). Floor `events` include it.
- **lair_event metaobjects** get a `game` field (the coordinator adds it to the definition and fills it in). `snippets/lair-config.liquid` passes it as `game`.
- **Floor `games`** already carry `system` ("D&D 5e", "Pathfinder 2e" …): that's a TTRPG session's sub-category.
- The calendar shows a second row of chips under "TCGs" (by `game`) and under "TTRPG" (by `system` for sessions and `game` for events), built from what's on.

**Implemented.** Deviation: the Lair app doesn't make events. The staff page's "events" are table holds (`POST /blocks`, type `tournament`, `market`, `event` …), and the floor's `events` has always been an empty list. So `POST /blocks` takes the optional `game` (trimmed, up to 40 characters, kept in the new `blocks.game`), and every floor `blocks` item carries `game` (or `null`), for the public too, next to the public label. Events from lair_event metaobjects reach the calendar through `lair-config` with their `game`, so the backend doesn't read that field.

## 7. What the coordinator does

- **Store data:**
  - The new menu (`dg-main-menu`) and the "Session gift" product.
  - The `game` field on lair_event, and Oddity Alley's price note "Free entry".
  - Product tags for the shop's TCG and TTRPG filters.
- **Merging, deploying and theme uploads.** Mo approves the new scopes in Shopify admin after the app deploy.
- **Agents must not:** write to the store, push, upload theme files or call the live Worker.

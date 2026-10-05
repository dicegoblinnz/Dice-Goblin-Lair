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

## 2. Spend by month and financial year

> "I want it to be able to be broken down monthly and yearly, and try to follow the financial year."

- **`GET /members/:customerId/spend`** (staff):
  ```
  { months: [ { month: 'YYYY-MM', amount, orders } ],     // the last 24 months, oldest first, months with nothing included as 0
    years:  [ { fy: '2026/27', from: '2026-04-01', to: '2027-03-31', amount, orders } ],  // up to the last 4 financial years, newest first
    total, since: 'YYYY-MM-DD' | null }                 // since: the first order the Lair knows about
  ```
- Source: the Lair's own `spend` table (orders/paid). If it can, the backend also fills in older orders for that customer from Shopify (orders query by customer; `read_all_orders` when granted, otherwise Shopify's last 60 days), once per customer, idempotent by order id. Say which in the code; never double-count an order.

## 3. Session gifts

> "sell session gift bundles where people can gift the receipt to someone and have them redeem it"

- **Store setup (coordinator):** product "Session gift", variants "5 sessions" $50 (SKU and barcode `LAIR-GIFT-5`) and "10 sessions" $100 (`LAIR-GIFT-10`). Draft until the backend is live.
- **orders/paid:** a paid line whose SKU matches `/^LAIR-GIFT-(\d{1,3})$/i` issues `quantity` **unlinked** passes of N sessions each, whoever bought it:
  - `label` "Gift: N sessions", `source: 'gift'`, `orderName`, `cover` the table price, `pricePaid` as for passes, holder name `null`, note "A gift from <buyer's first name>" when known.
  - Idempotent per (order, line, unit), as for passes.
  - **Email the buyer** (the order's email): "Your session gift is ready". One block per code: the code in big letters, "N sessions at the Dice Goblin Lair", and how to redeem: "Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under 'Got a pass code?'". No email address on the order: staff get the codes instead.
- Redeeming is the existing `POST /me/passes/claim { code }`. A claimed gift becomes theirs (`source` stays `'gift'`).
- Every pass view: `source` can be `'gift'`. Member views show "A gift" for it.

## 4. Library holds (reserve a board game)

> "a button to reserve a boardgame … let us know that this happened and we will hold it for 3 days by 12pm on the third day. If they don't pick it up it automatically goes back on the shelf. And if anyone tries to book it out other than the user it registers as reserved and you need to wait …"

### Rules
- **Who:** logged-in library members. Their plan comes from their Shopify customer tags (Simplee), matched without case: a tag containing "hoard" → 5 games, "stash" or "treasure" → 3, "grab" or "loot" → 1; a plain `library-member` tag with none of those → 1. No plan → 403 "Join the library to reserve games, friend."
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

## 5. Joining a TTRPG session without an account

> "have someone join a game by getting a QR code generated for them … it basically just emails the gm that a new person joined and their details inside the form and they will be charged when they arrive. Simple as that."

- **`POST /bookings { kind: 'gm-seat', gameId, name, email, phone?, people, players?, notes? }` works without logging in**, for any session that's open, including a single session of a weekly series. "Save my seat every week" (`POST /games/:id/join-series`) still needs an account, because their member code is the ticket.
  - The same rules as members otherwise: seats, seats held for regulars, the 6-upcoming-per-email limit, the per-client rate limit.
  - `name` and a valid `email` are required; `phone` is optional (up to 30 characters).
  - The response is as today: the booking with its `ref`, the ticket code the QR shows.
- **Every new player emails the GM** (`gmEmail`): a guest, a member, a weekly regular's first seat, or a player staff add. Subject "New player for <title>, <when>: <name>". Details: name, email, phone (if given), seats, players' names and characters, notes, "They pay at the counter when they arrive", and the seats left. No GM email on file: staff get it. Seats that maintenance rolls forward for regulars don't email the GM.
- **The guest's confirmation email** adds: "Make an account with this email any time, and your seats will show up in My Lair."
- **Guest seats join their account:** on `GET /me`, bookings and event sign-ups with no `customerId` whose email matches the logged-in member's email (ignoring case), and that are upcoming or ended in the last 30 days, get the member's `customerId`. Stamps then follow (section 1).

## 6. Calendar sub-categories

> "a sub category for TCGs and TTRPGs so that they can be filtered"

- **Events made in the Lair app** (staff page) take an optional `game` (up to 40 characters, like "Magic: The Gathering", "Pokémon", "Riftbound"). Floor `events` include it.
- **lair_event metaobjects** get a `game` field (the coordinator adds it to the definition and fills it in). `snippets/lair-config.liquid` passes it as `game`.
- **Floor `games`** already carry `system` ("D&D 5e", "Pathfinder 2e" …): that's a TTRPG session's sub-category.
- The calendar shows a second row of chips under "TCGs" (by `game`) and under "TTRPG" (by `system` for sessions and `game` for events), built from what's on.

## 7. What the coordinator does

- **Store data:**
  - The new menu (`dg-main-menu`) and the "Session gift" product.
  - The `game` field on lair_event, and Oddity Alley's price note "Free entry".
  - Product tags for the shop's TCG and TTRPG filters.
- **Merging, deploying and theme uploads.** Mo approves the new scopes in Shopify admin after the app deploy.
- **Agents must not:** write to the store, push, upload theme files or call the live Worker.

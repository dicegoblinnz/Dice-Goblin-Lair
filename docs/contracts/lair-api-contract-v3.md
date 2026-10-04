# Lair app API: round 3 (3 Oct 2026, morning)

This file only lists changes. `lair-api-contract.md` (same folder) is still the base. The backend is `/home/claude/dice-goblin-lair/src/{index,lair,core,shopify,config}.js`, and the theme talks to it through `store.cfg.api` (currently `/apps/liar`).

Money is in cents and times are epoch ms. "Logged in" means the app proxy sent a `logged_in_customer_id`. Every route also needs a DemoBackend version in `assets/lair-core.js`.

## 1. Ticket codes and QR
- New booking and sign-up refs look like `SAM-4821`: the booker's first name (A–Z only, upper case, 2–10 letters; `GOB` if there's no usable name), a dash, then 4 digits. Refs are unique. Old `GOB-XXXXXX` refs keep working.
- Tickets show a **QR code** of the ref (exact text, with the dash) and the ref printed under it. The theme makes the QR in JavaScript with a small QR encoder added as an asset (`assets/qr.js`, exposing `window.Lair.qrSvg(text, { size })`). Use a proven MIT encoder such as qrcode-generator (Kazuhiko Arase) and keep its licence header.
- Check-in (`POST /checkin`, and the POS route below) accepts:
  - `NAME-1234`, with or without the dash
  - the legacy `GOB-XXXXXX`, with or without the dash
  - a member card `DGC-<customerId>`, which returns the person's bookings for today

## 2. Rules apply on the public booking page, staff included
- `POST /bookings` with `kind: 'table'` applies the customer rules to everyone. Staff only skip them when they send `staffOverride: true` (the staff page does; the public page never does).
- The table rule hasn't changed: allowed tables = ceil(people / seats per table), doubled for `wargame` or `bigbox`. Seats must fit everyone.
- Walk-ins (`kind: 'walkin'`, staff only) may list several tables.

## 3. GM games
- `seats` counts **players only**, 2–8. The GM is never counted. For the table check, the players must fit (players ≤ table seats). A GM can always take up to max(2, ceil(players / 4)) tables.
- `gmFee` 0, 500 or 1000. **No fee needs a manager's OK any more.** A game is only pending when the GM isn't trusted (not staff, not tagged `gm`).
- Joining a game **needs a login**: 401 "Log in to join a game".
  - `people` can be 1 up to the seats left (max 8).
  - Send `players: [{ name, character }]`, one entry per seat.
  - `pay: 'now'|'day'` as before.
- **Join every session:** `POST /games/:id/join-series { people, players, name, email }` (logged in). It takes a seat in every upcoming session of the game's series that has room, now and as new sessions appear.
  - Returns `{ member: { seriesId, people, players }, booked: [{ gameId, start, ref }], full: [{ gameId, start }] }`.
  - Leave with `POST /series/:id/leave`. Skip one session by cancelling that seat booking (`POST /bookings/:id/update { status: 'cancelled' }`, the owner's own seat).
  - Series members pay at the counter for each session.
- **Message players:** `POST /games/:id/message { text, scope: 'session'|'series' }` (the GM who owns it, or staff). It emails every player with a seat in that session (or every series member and upcoming seat holder) and returns `{ sent }`. It's rate limited.
- **Cancelling:**
  - A GM can cancel a session until 1 hour after it starts. `scope: 'series'` cancels every future session.
  - All players get an email, and any seat paid online is flagged "refund due" (GM cancelled: always refunded).
  - A player dropping their own seat emails the GM.
- **No-shows:** marking an unpaid booking or seat `noshow` just records it, with no email and no charge. A paid one gets a "Refund?" note for staff to decide. Staff can mark a paid booking refunded with `POST /bookings/:id/update { refunded: true }`.
- **Staff management** (staff only):
  - `POST /games/:id/edit { title, system, blurb, seats, level, age, tags, safety, characters, bring, contentNotes, sessionZero, gmFee, start?, end?, tables? }`. Moving time or tables moves the GM hold and every seat, and checks the tables are free.
  - `POST /games/:id/players { name, email, people, players, customerId? }` adds a seat booking for someone, with no payment and no rules beyond seats. It links `customerId` when given or when the email matches a known member.
  - Removing a player: `POST /bookings/:id/update { status: 'cancelled' }`.
  - Creating a game for a GM: `POST /games` with `gmCustomerId` or `gmEmail` (matched against members).
  - `GET /members?q=` (staff): search known members by name or email. Returns `[{ customerId, name, email, birthday, spendYear, spendTotal, lastSeen }]`.

## 4. Members, spend, birthdays and dice
- **Members:** the app keeps a member record per Shopify customer: `customerId`, `name`, `firstName`, `email`, `birthday` ('MM-DD'), `spendYear`, `spendTotal`, `rollsFromSpend`, `rollsUsed`, `lastSeen`. It's filled when a logged-in customer books, joins, or opens My Lair.
- `POST /me/profile { firstName, name, email, birthday }` (logged in). Birthday is 'MM-DD' or empty.
- **Spend:** every paid order from orders/paid (online, draft or POS) with a customer adds its subtotal after discounts to that member's spend. Each $20 of spend is one bonus roll. There's no refund clawback.
- **Personal card:** My Lair shows a QR code of `DGC-<customerId>`. Staff scan it in the POS extension to attach the customer to the POS cart, so in-store spend counts too.
- **`GET /me` adds:**
  - `member: { firstName, birthday, spendYear, spendTotal, card: 'DGC-123' }`
  - `rolls: { daily: bool (today's free roll still available), bonus: n (stacked spend rolls), toNext: cents (spend until the next bonus roll) }`
  - `prizes: [{ kind, code?, amount?, expiresAt?, at }]` (the last 10)
- **`POST /roll`:**
  - With no body, or `{ kind: 'fun' }`, or from someone not logged in: it returns `{ roll }` only, never a prize. The home page uses this.
  - `{ kind: 'daily' }` (logged in, once per Lair day): a natural 1 gives $1 store credit, and a natural 20 gives a personal 10% off code valid 30 days that doesn't combine with other discounts.
  - `{ kind: 'bonus' }` (logged in, uses one stacked spend roll): any face containing the digit 1 (1, 10–19) gives $1 store credit, and 11 gives $2. A 20 gives the 10% code.
  - The response is `{ roll, kind, prize: null | { kind: 'credit', amount } | { kind: 'percent', percent: 10, code, expiresAt }, message, rolls: { daily, bonus, toNext } }`.
  - If the code can't be made (missing permission), the prize still comes back with `code: null` and the message "Show this screen at the counter to claim it".
- **Birthdays:** once a day, members with a birthday in the next 7 days get a personal birthday code, emailed to them, and staff get a summary.
  - The discount follows spend over the last 12 months: under $100 gives 10%, $100–$499 gives 15%, $500 and up gives 20%. The code lasts 14 days, once per member per year.
  - `GET /members/birthdays` (staff) lists the next 30 days with spend.

## 5. Events
- **New `lair_event` fields:**
  - `entry_fee` (number_decimal, NZD per person)
  - `game_tables` (text like `T14+T15, T16+T17, T18+T19`: each item is one bookable game spot)
  - `tables` keeps meaning "held" (blocked), for example painting tables `T20-T21`.
- **Joins** (`POST /events/:id/join`) take `pay: 'now'|'day'`. With an `entry_fee` and pay now, the response adds `checkoutUrl`, and the orders/paid webhook marks the join paid. Without a fee there's no pay option.
- **Game spots:** `POST /events/:id/reserve { name, email, people (1–2), pay }` books the first free game spot for that date as a normal table booking (`extras: ['wargame']`, linked to the event date). It returns `{ booking, spotsLeft, checkoutUrl? }`.
  - The floor adds `eventSpots: { [occurrenceId]: { total, taken } }`.
  - Those tables stay bookable by anyone else through the normal booking page.
  - Check-in is the same as a booking.
- **Add to calendar** stays on events that don't need joining, for everyone (no login).

## 6. POS extension routes (Worker, not through the app proxy)
- Auth: `Authorization: Bearer <POS session token>`. That's a JWT signed HS256 with the app's client secret, with `aud` = client ID and `dest` = `https://ep0qiq-rp.myshopify.com`. Anything else gets 401.
- `POST /pos/checkin { code, force? }` returns the same as `/checkin`, plus:
  - `lines: [{ title, price (string "40.00"), quantity, taxable, properties: { _booking: ref } }]`, the fee still to pay, ready to add to the POS cart as a custom sale
  - `customer: { id } | null`
- `POST /pos/member { code: 'DGC-123' }` returns `{ customerId, name, rolls }` and confirms the member exists.
- In the orders/paid webhook, POS orders (`source_name: 'pos'`) with a line property `_booking` mark that booking or join as paid. POS orders can only be made by staff.

## 7. Emails
Every email is now HTML, with a plain-text copy:
- a Dice Goblin header
- a big title
- a details table with bold labels
- one clear button where there's an action
- a footer with the address, phone and hours

The voice is Gobgob: they/them, sometimes calls you "friend".

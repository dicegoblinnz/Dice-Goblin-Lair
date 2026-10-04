# Lair app API: changes for 3 Oct 2026 (contract for the theme)

All routes sit under the theme's `store.cfg.api` (the app proxy, currently `/apps/liar`). Every request and response is JSON. Errors look like `{ error: "Plain sentence for the customer." }` with status 4xx. The current backend is `/home/claude/dice-goblin-lair/src/{lair,core}.js`; the routes below are being added by the main agent right now. Every route needs a matching implementation in `DemoBackend` in `assets/lair-core.js`, so the theme works in demo mode and in the local renderer.

Money is in cents. Times are epoch ms. `who` is the logged-in Shopify customer, taken from the app proxy. Staff are customers tagged `staff`; trusted GMs are tagged `gm`.

## Floor: `GET /floor?from=&to=` (existing, extended)
New fields:
- `shopTables: ["T1","T2","T3"]`: shop tables. They're closed to public bookings and GM games unless an opening covers the whole time.
- `openings: [{ id, tables: [...], start, end, note? }]`: windows when a manager opened shop tables. `note` is only sent to staff.
- `eventJoins: { "<handle>@YYYY-MM-DD": peopleCount }`
- `games[]` (public game), with these fields added:
  - `schedule`: 'one-shot' | 'weekly' | 'fortnightly' | 'flexible'
  - `seriesId`: string or null. Sessions of one recurring game share it.
  - `gmFee`: cents. 0, 500 or 1000.
  - `seatPrice`: cents. The room's table price plus `gmFee`, so $15 in the main room with the standard fee and $20 in the fancy room.
  - `room`: room id
  - `characters`: 'pregens' | 'bring' | 'at-table' | ''
  - `bring`: text
  - `contentNotes`: text
  - `gmBio`: text
  - `image`: absolute URL or null
  - `gmFeeApproved`: bool
  - For the game's own GM and for staff only: `players: [{ name, character, ref, paid }]`
- Staff only: `joins: [{ id, ref, occurrenceId, name, email, people, status }]`

## Bookings: `POST /bookings` (existing, extended)
- `kind: 'table'`: `extras` may contain 'wargame', 'bigbox' and 'celebrating'. Other extras are ignored.
  - Table rule for non-staff: tables allowed = ceil(people / seatsPerTable), times 2 when extras include 'wargame' or 'bigbox'. More tables than that gives 422 "That's more tables than your group needs…". Everyone must also fit: seats ≥ people.
  - Shop tables need an opening that covers the whole time, or 422 "T1 is a shop table…".
- `kind: 'gm-seat'`: send `players: [{ name, character }]` with exactly `people` entries (1–4). `name` is required; `character` is optional (max 60 chars). The booker's `name` and `email` are still required.
  - The amount is `game.seatPrice × people`.

## Check-in (staff): `POST /checkin { code, force? }`
- `code` is the raw scanner input. It's trimmed and upper-cased, and the app finds `GOB-XXXXXX` in it (a missing dash is fine).
- Returns `{ found: true, kind: 'booking'|'join', booking?, join?, game?, checkedIn: bool, due: cents, message }`.
  - `due` is what's left to pay at the counter (0 if they paid online).
  - `message` is a plain line, e.g. "Checked in: Sam, 4 people at T2. Charge $40." or "This booking is for Saturday 3 October, not today."
- 404 when not found.

## Openings for shop tables (staff)
- `POST /openings { tables, start, end, note }` returns `{ opening }`.
- `POST /openings/:id/delete` returns `{ ok: true }`.

## GM games
- `POST /games`: create. Needs a logged-in customer; 401 "Log in to run a game" otherwise.

  Body:
  ```
  { title, system, gm, email, gmBio, blurb, seats (2-8), level ('new'|'some'|'veteran'), age ('All ages'|'13+'|'18+'),
    tags[], safety[], characters, bring, contentNotes,
    tables[] (chosen by the GM, one room, free for the first session; seats must fit seats+1),
    start, end (first session; whole hours inside opening hours, like table bookings),
    schedule ('one-shot'|'weekly'|'fortnightly'|'flexible'), gmFee (0|500|1000) }
  ```

  Response: `{ game, sessions: [{ id, start }], skipped: [{ start, reason }], pending: bool }`.

  How it works:
  - weekly and fortnightly create every session up to the booking horizon, and the app adds more automatically as time passes.
  - flexible creates the first session only; the GM adds dates.
  - A session whose tables are already taken is skipped and reported in `skipped`.
  - Status is 'pending' (staff approve it) unless the GM is staff, or is tagged `gm` and has gmFee ≤ 500. A gmFee above 500 always needs approval.
- `POST /games/:id/sessions { start, end, tables? }`: the GM (owner) or staff adds a session to a flexible or recurring game. Returns `{ game }`.
- `POST /games/:id/update`: existing. `{ status: 'cancelled', scope: 'session'|'series' }`. Staff approving one session approves every pending session in its series.
- `POST /games/:id/image { dataUrl }`: the owner or staff uploads a JPEG, PNG or WebP, at most 600 KB after the client resizes it (resize to 1200px wide first). Applies to every session in the series. Returns `{ image: url }`.
- `POST /gm-profile { name, bio }`: logged-in customers. Returns `{ profile }`.

## Events (from the events agent's contract, built by the main agent)
- `POST /events/:occurrenceId/join { name, email, people, note }` returns `{ join, spacesLeft }`.
- `POST /events/joins/:id/cancel` (staff or owner) returns `{ ok: true }`.
- `POST /contact { kind: 'host-event', name, email, phone, eventType, when, people, details }` returns `{ ok: true }`.

## Dice roller: `POST /roll {}`
The roll happens on the server.

Response:
```
{ roll: 1..20, prizeRoll: bool, prize: null | { kind: 'percent', code, percent: 5, expiresAt } | { kind: 'dice', code, variantId, productUrl, expiresAt }, message }
```
- The first roll of the day per visitor (customer id, or IP address) is the prize roll. Later rolls are for fun, and `prizeRoll` is false.
- A natural 20 on the prize roll gives a personal 5% off code, valid 24 hours and usable once.
- A natural 1 on the prize roll gives a free dice from the Dice Chest. The code makes that product free when the order includes anything else.
  - Theme: add the variant to the cart (`/cart/add.js`), then apply the code (`/cart/update.js` with `{ discount: code }`, falling back to `/discount/CODE?redirect=/cart`).
- On other numbers, or later rolls, the theme shows a genuinely random purchasable product: fetch `/collections/all/products.json?limit=250&page=N` with a random page, keep available products, and skip anything tagged `hidden` or `dice-chest-prize` and library items.
- If codes can't be made yet (the Shopify permission is missing), `prize` still comes back with `code: null` and the message "Show this screen at the counter to claim it".

## My Lair: `GET /me`
Needs a logged-in customer; 401 otherwise.

Returns:
```
{ customer: { id, staff, gm }, gmProfile: { name, bio } | null,
  bookings: [own table bookings: ref, tables, start, end, people, status, paid, amount, pay],
  seats: [own gm-seat bookings: ref, gameId, gameTitle, start, end, people, status, paid, amount, players],
  games: [games this customer runs: public game + players + status],
  joins: [own event joins: ref, occurrenceId, title, start, people, status],
  credits: [{ gameId, title, players, amount, status, at }] }
```
Upcoming items plus the last 30 days. Bookings are only linked when the customer was logged in when booking.

Cancelling your own booking already exists: `POST /bookings/:id/update { status: 'cancelled' }`.

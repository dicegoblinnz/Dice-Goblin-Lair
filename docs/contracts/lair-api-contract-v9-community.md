# Lair app API: round 9, community (9 Oct 2026)

**Changes only.** On top of `lair-api-contract-v8.md` and everything before it; where they disagree, this file wins. Money
in cents, times in ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx
or 5xx.

**Where things live:** backend `r9-community-api` (on `r9-api-base`): the routes in `src/community.js` (methods mixed into
the `Lair` Durable Object), wired in `src/lair.js`; theme `r9-community` (on `r9-base`): `assets/lair-staff-community.js`
(the staff page's Community tab and walk-ins), `assets/lair-community.css`, `renderOffers()` in `assets/my-lair.js`, the
`LiveBackend` methods in `assets/lair-core.js` and the demo in `assets/lair-demo.js`.

Mo (9 Oct, 10:45): "if you are coming you register and show up then the more you show up the more you get added into our
list of say Pokemon turnouts … they will be the ones where we will give the option to buy our products before it goes to
the rest of the shop or even online … group them on the backend section so that they get the product link access based
on their account rather than a secret page … have the allocation be present from 3 avenues the last 3 months turnouts,
the last year turnouts and total spend at dice goblin."

The coordinator's decision: no secret pages. Each person sees the offer in their own My Lair, with a checkout link that
only works for their account. Staff pick the group from three lists: turnouts in the last 3 months, the last year, and
total spend. Turnouts count people checked in at events, so "I'm coming" and "Maybe" feed the numbers.

---

## 1. Turnouts

### Rules
- **A turnout** is a member checked in:
  - at an event: a sign-up checked in (`event_joins.status = 'attended'`) counts for whoever signed up (their account),
    and each member guest on it (round 8, `event_join_guests.customer_id`) counts for themselves; an event game spot (a
    `table` booking with an `occurrence_id`) counts once it's `seated` or `done`;
  - at a TTRPG session: a seat (`gm-seat`) `seated` or `done`.
- Never: table bookings and walk-in tables, no-shows, cancellations, held places, the GM running a session, people without
  an account. A member counts once per event date or session, however many rows they're on.
- **Nothing is stored:** turnouts are counted from check-ins every time they're read, so undoing a check-in (status back to
  `confirmed`) takes the turnout back. History counts too (from the first sign-ups the Lair has).
- **By game:** the event's Game field (`lair_event.game`, now in the rules' events with `type` from `event_type`), else its
  kind: `tcg` TCGs, `rpg` TTRPG, `wargame` Wargames, `market` Markets, `social` Social games, `tournament` Tournaments,
  `learn` Learn to play, `launch` Launches, `other` Other events. An event the Lair no longer has is "Other events". A TTRPG
  session counts under its system, else "TTRPG". Names as staff wrote them (spaces tidied), merged without case; a game's
  key is its lower-case name, and its shown name is the spelling of its latest turnout.
- **The windows:** the last 3 months runs from midnight (Lair time) on the same day 3 calendar months ago (9 Oct: from
  00:00 9 Jul; 31 May: from 28 Feb), the last 12 months likewise.

### Routes
- **`GET /community?game=&sort=3m|12m|all|spend`** (staff, perm `community`):
  ```
  { games: [ { key, name, turnouts: { m3, m12, all }, people: { m3, m12, all } } ],   // busiest in the last 3 months first
    members: [ { customerId, name, code, turnouts: { m3, m12, all }, spend, lastSeen, lists: [ { id, name } ] } ],
    total, game: 'all' | key, sort, windows: { m3, m12 }, at }
  ```
  - `game` is a game's key or name (any case); empty or `all` is every game. Every game lists anyone with a turnout or any
    spend; one game lists only people who turned up for it, with their numbers for that game.
  - `spend`: total spend at Dice Goblin (round 6's `spend`: paid orders online and at the POS). `lastSeen`: their latest
    turnout (for that game), or null.
  - Sorted by `sort` (default `3m`), ties by the others (3m: 12m, all, spend; 12m: 3m, all, spend; all: 12m, 3m, spend;
    spend: 3m, 12m, all), then name. Up to 1000 members; `total` says how many matched. One pass over every turnout.
- **`POST /events/:occurrenceId/attend { code }`** (staff, perm `checkin`): a walk-in at one of today's events.
  - The member code (scanned or typed, any case, dashes optional) makes a sign-up for one: `status 'attended'`,
    `arrived_at` now, `source 'walk-in'`, the member's name and email, the event's entry fee as its `amount` (due at the
    counter like any sign-up; a free event stays free). Works for events with no sign-ups (no capacity) too.
  - "Today": the date's Lair day is today, or it's under way (from 3 hours before), as check-in reads it.
  - → `{ join (staffJoinView + source), row (the check-in row), message, notice }`: `message` "Walk-in added and checked in:
    <Name> for <event>." plus " Charge $5." when there's a fee; `notice` "That's 17 people for 16 places." when it's over
    the capacity (nobody is refused for that), else null.
  - Errors: 404 "That event date could not be found."; 422 "Walk-ins are for today's events. That one is on Fri 16 Oct.";
    422 "Scan or type their member code."; 404 "No member has the code <CODE>. Check it, or find them under Members."
    (`<CODE>` as typed, in capitals); 409 "<Name> is already checked in at <event>."; 409 "<Name> is already signed up for
    <event>. Check them in from their sign-up under Event sign-ups today." (their own sign-up or one they're a guest on).

## 2. Lists

- **`GET /community/lists`** (staff, perm `community`) → `{ lists }`, latest changed first.
- **`POST /community/lists { name, note?, customerIds }`** → `{ list }`.
- **`POST /community/lists/:id { name?, note?, add?: [customerId], remove?: [customerId] }`** → `{ list }`.
- **`POST /community/lists/:id/remove`** → `{ ok: true, id }` (also when it's gone already). Offers made from it keep their
  people.
- `list`: `{ id, name, note, members: [ { customerId, name, code } ], count, createdBy: { customerId, name }, createdAt,
  updatedAt }`, members by name.
- Errors: 422 "Give the list a name."; 422 "Keep the name to 60 characters or fewer."; 422 "Keep the note to 300 characters
  or fewer."; 422 "Gobgob doesn't know some of those people. Pick them from the Community list again." (a customer ID that
  isn't a Lair member); 422 "A list holds up to 2000 people."; 409 "There's already a list called <name>. Pick another
  name." (names are unique without case); 404 "That list could not be found."

## 3. Early access offers

### Rules
- **An offer** is a Shopify product (one or more of its variants) for a list and/or picked members, with a per-person limit
  (1 to 50, default 1), total units (optional: the allocation, 1 to 10000), opens (optional) and closes (Lair time), a
  short message (up to 300 characters), whether to email them, and a status: `draft`, `open` or `closed`. Views also say
  `scheduled` (open, before its opening time).
- **Who it's for** is copied when it's saved: the list's members and the people picked, each a Lair member (they need an
  account to claim). Editing who it's for replaces them, except anyone with a claim, who stays.
- **The product** must be Active in Shopify (`ACTIVE`, or `UNLISTED`: sellable by link): a draft or archived one is refused.
  One on the online store (`onlineStoreUrl` set) is allowed with a warning: "Anyone can buy this online right now. Hide it
  from the online store in Shopify until early access ends."
- **A claim** (`POST /offers/:id/claim`): the member must be logged in and on the offer, the offer open (after its opening
  time, before its closing), the variant one on offer, the quantity 1 to the limit, what they've paid for plus this within
  the limit, and (with total units) this within the units left. Units held = paid claims + waiting claims + claims whose
  checkout is being made.
  - The claim's row is saved first (`creating`, holding its units), then Shopify makes the **draft order for that
    customer** (`purchasingEntity.customerId`, one line: the variant and quantity, tagged `lair-offer`, `_offer_claim` on
    the order and the line), then the claim is `waiting` with the draft's invoice URL. Shopify failing lets the units go
    (`released`, reason `failed`). A member has one claim being made at a time.
  - **One unpaid claim per member per offer:** claiming again replaces it (the old one is `released`, reason `replaced`,
    and its draft order deleted once the new one exists).
  - **Let go** after 48 hours or when the offer closes, whichever is first (`expires_at`): a waiting claim past it counts as
    released straight away everywhere; maintenance stores it (reason `expired`) and deletes its draft order
    (`deleteDraftIfOpen`, so a checkout that was just paid stays).
  - **Paid:** orders/paid marks the claim `paid` when the order carries `_offer_claim` (note attribute or line property),
    comes from a draft (`source_name` empty or `shopify_draft_order`), and Shopify says the claim's own draft order became
    this order. One paid after it was let go is still paid (they paid) and `STAFF_EMAIL` gets "Early access paid late:
    <product>" to check the stock. The order's spend counts as any order's does.
  - A checkout link opened by someone else still checks out as that member's order; the page only ever shows a member
    their own link.

### Staff routes (perm `community`)
- **`GET /products/search?q=`** → `{ products: [ { id, title, handle, status, active, published, image, variants: [ { id,
  title ('' for a single Default Title), price, stock (null without read_inventory), available, image } ] } ] }`, up to 10.
  Errors: 422 "Type at least 2 letters of the product's name."; 503 "Shopify hasn't let the Lair read products yet. Approve
  the app's read_products permission in Shopify admin (Apps › Dice Goblin Lair), then try again."; 503 "Shopify didn't
  answer just now. Try again in a minute."
- **`GET /offers`** → `{ offers }`: open ones first (soonest closing), then scheduled, drafts, closed (newest first), up to
  200.
- **`GET /offers/:id`** → `{ offer, claims: [ { id, customerId, name, code, variantId, variantTitle, price, quantity, status
  ('paid' | 'waiting' | 'creating' | 'released'), reason, expiresAt, paidAt, orderId, createdAt } ] }`, newest first.
- **`POST /offers { productId, variantIds, perPerson?, totalUnits?, opens?, closes, message?, listId?, customerIds?, email? }`**
  → `{ offer, warning }` (a draft). Times: ms, an ISO time with its offset, or `YYYY-MM-DDTHH:mm` (or a space) in Lair time.
- **`POST /offers/:id { …the fields that change }`** (draft or open) → `{ offer, warning, notice }`. Once open the product
  can't change; the total can't go below the units held; `notice` "1 person has a claim already, so they stay on it." A
  new closing time brings waiting claims' times forward if it's sooner.
- **`POST /offers/:id/open { email? }`** → `{ offer, emailed, warning }`. Shopify is asked about the product again (it must
  still be Active). It opens at its opening time if that's later, else now. With `email`, everyone on it with an email
  (their Lair profile's, else their verified Shopify account email) gets "Early access: <product>" now, or when it opens
  (maintenance). `emailed`: how many now.
- **`POST /offers/:id/close`** → `{ offer, released }`: closed now; unpaid claims let go (reason `closed`), their draft
  orders deleted.
- `offer`: `{ id, status, product: { id, title, handle, image, status, published }, variants: [ { id, title, price, image } ],
  perPerson, totalUnits, unitsLeft (null with no total), claimed: { paid, waiting, people }, opens, closes, message, list: {
  id, name } | null, people: [ { customerId, name, code } ], count, email, emailedAt, createdBy, createdAt, updatedAt,
  openedAt, closedAt, warning }`.
- Errors: 422 "Pick a product from the search."; 422 "Pick at least one of its options to offer."; 422 "That option isn't
  part of <product>. Search for it again."; 422 "The limit per person is a number from 1 to 50."; 422 "Total units is a
  number from 1 up, or leave it empty for no limit."; 422 "Pick when early access closes."; 422 "Pick a real date and time,
  like 2026-10-18 18:00."; 422 "It has to close after it opens."; 422 "That closing time has already passed. Pick a later
  one."; 422 "Keep the message to 300 characters or fewer."; 422 "Gobgob doesn't know some of those people. Pick them from
  the Community list again."; 404 "That list could not be found."; 422 "<product> is a draft in Shopify, so it can't be
  sold. Make it Active first: it can stay hidden from the online store." (or "is archived"); 404 "Shopify doesn't have that
  product any more. Search for it again."; 404 "That offer could not be found."; 409 "That offer has closed. Make a new
  one."; 409 "The product can't change once early access is open. Close it and make a new one."; 422 "<N> units are claimed
  already, so the total can't go below <N>." ("1 unit is"); 422 "Add a list or some people before opening it."; the two
  503s above.

### Member routes
- **`GET /me`** adds **`offers`**: the open offers they're on (after opening, before closing), soonest closing first:
  `{ id, title, image, message, variants: [ { id, title, price, image } ], limit, bought (paid so far), canBuy (left of their
  limit), unitsLeft (null with no total), opens, closes, claim }`. `claim`: their waiting claim, else their latest paid one,
  else null: `{ id, variantId, variantTitle, price, quantity, status ('waiting' | 'paid'), checkoutUrl (waiting only),
  expiresAt, paidAt }`. Only their own claims and links.
- **`POST /offers/:id/claim { variantId, quantity }`** (logged in) → `{ claim, offer }` (`offer` as in GET /me). `variantId`
  can be left out when there's one option; `quantity` defaults to 1.
- Errors: 401 "Log in to claim early access."; 404 "That offer could not be found." (also a draft, or an offer
  they're not on: it never says one exists); 409 "Early access to <product> has closed."; 409 "Early access to <product>
  opens Sat 10 Oct, 9am."; 409 "<product> can't be bought right now. Have a chat with us at the counter." (no longer Active,
  or the variant's gone); 422 "Pick one of the options on offer."; 422 "Pick how many: 1 to <limit>."; 409 "Hang on:
  Gobgob's still setting up your last one. Try again in a moment."; 409 "That's more than your limit of <limit>: you've got
  <n> already, so <left> more at most." / "You've got your <limit> already, friend. That's the limit."; 409 "Every one has
  been claimed. Sorry, friend."; 409 "Only <n> left. Pick <n> or fewer."; 503 "Gobgob can't make checkouts right now. Try
  again soon, or ask at the counter." (Shopify not connected); 503 "Shopify didn't answer just now. Try again in a minute.";
  503 "Shopify couldn't make your checkout just now. Try again in a minute."

### Email
"Early access: <product>" (subject and title): "Kia ora <first name>, Gobgob saved you a spot before anyone else." / "Grab
it in My Lair before Sunday 18 October, 6pm." / Limit: N per person / the staff's message, if any / button "Open My Lair".
Only when staff tick it. A claim's confirmation is Shopify's own order email.

## 4. Shopify Admin API operations (2026-07, checked with the Shopify MCP's `graphql_schema` and `validate_graphql_codeblocks`)

| Operation | What | Scopes |
|---|---|---|
| `LairOfferProducts($query)` | `products(first: 10, query: $query, sortKey: RELEVANCE) { nodes { id handle title status onlineStoreUrl featuredMedia { preview { image { url } } } variants(first: 100) { nodes { id title price inventoryQuantity availableForSale media(first: 1) { nodes { preview { image { url } } } } } } } }` | read_products (read_inventory for stock) |
| `LairOfferProductsPlain($query)` | the same without `inventoryQuantity` (asked when read_inventory is refused) | read_products |
| `LairOfferProduct($id)` / `LairOfferProductPlain($id)` | `product(id: $id) { …the same fields… }` | read_products |
| `LairOfferDraft($input)` | `draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } }` with `{ purchasingEntity: { customerId }, tags: ['lair-offer'], note, customAttributes: [_offer_claim], lineItems: [{ variantId, quantity, customAttributes }] }` | write_draft_orders (granted) |

The paid webhook uses the existing `DraftStatus` (`draftOrderOrderId`) and expiry the existing `DraftOpen` + `D`
(`deleteDraftIfOpen`). `ProductStatus` has `UNLISTED` from 2025-10: read as sellable. `reserveInventoryUntil` exists on
`DraftOrderInput` but isn't used (see Contract notes).

## 5. Stored (one `MIGRATIONS` entry, appended; found by its content in tests)
```sql
ALTER TABLE event_joins ADD COLUMN source TEXT
CREATE TABLE IF NOT EXISTS community_lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)
CREATE TABLE IF NOT EXISTS community_list_members (list_id TEXT NOT NULL, customer_id TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (list_id, customer_id))
CREATE INDEX IF NOT EXISTS community_list_members_customer ON community_list_members (customer_id)
CREATE TABLE IF NOT EXISTS early_offers (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_title TEXT NOT NULL, product_handle TEXT, image TEXT,
  product_status TEXT, published INTEGER, variants TEXT NOT NULL, per_person INTEGER NOT NULL, total_units INTEGER, opens_at INTEGER, closes_at INTEGER NOT NULL,
  message TEXT, status TEXT NOT NULL, list_id TEXT, email INTEGER NOT NULL DEFAULT 0, emailed_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER, opened_at INTEGER, closed_at INTEGER)
CREATE TABLE IF NOT EXISTS early_offer_members (offer_id TEXT NOT NULL, customer_id TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (offer_id, customer_id))
CREATE INDEX IF NOT EXISTS early_offer_members_customer ON early_offer_members (customer_id)
CREATE TABLE IF NOT EXISTS early_offer_claims (id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, customer_id TEXT NOT NULL, variant_id TEXT NOT NULL, variant_title TEXT,
  price INTEGER, quantity INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, draft_order_id TEXT, checkout_url TEXT, order_id TEXT, expires_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER, paid_at INTEGER, ended_at INTEGER)
CREATE INDEX IF NOT EXISTS early_offer_claims_offer ON early_offer_claims (offer_id, status)
CREATE INDEX IF NOT EXISTS early_offer_claims_customer ON early_offer_claims (customer_id, offer_id)
```

## 6. Maintenance (the 10-minute cron)
Closes open offers past their closing time (`closed_at` = `closes_at`) and lets their unpaid claims go; lets go waiting
claims past their time and claims stuck being made for 5 minutes; deletes those draft orders; sends the emails of offers
that opened since the last run. Its answer adds `offers: { released, closed, emailed }` when anything happened.

## 7. Staff routes and permissions

| Route | Permission |
|---|---|
| `POST /events/:occurrenceId/attend` | `checkin` |
| `GET /community` | `community` |
| `GET /community/lists`, `POST /community/lists`, `POST /community/lists/:id`, `POST /community/lists/:id/remove` | `community` |
| `GET /products/search` | `community` |
| `GET /offers`, `GET /offers/:id`, `POST /offers`, `POST /offers/:id`, `POST /offers/:id/open`, `POST /offers/:id/close` | `community` |

Each is guarded with `this.requireStaff(who); // perm: <key>` (today's gate). `POST /offers/:id/claim` is a member route.

## 8. Theme
- **Staff page:** tab `['community', 'Community']` (perm `community`) at the end of `TABS`, its panel
  `#panel-community` holding `<staff-community>` (`assets/lair-staff-community.js`, loaded after `lair-staff-codes.js`;
  styles in `assets/lair-community.css`, loaded after `lair-staff-admin.css`). Three views: Turnouts (game chips with their
  3-month turnouts; sort chips and sortable column headers for 3 months, 12 months, all time and total spend; a table with
  room, one card each on a phone; ticks and quick picks "Top 10 this quarter", "Top 10 this year", "Top 10 by spend"; a
  selection bar: Save as a list, Add to a list, Early access), Lists (open, take people off, rename, delete: asks first),
  Early access (offers, New offer: find the product, its options, limit, units, opens/closes, a list and/or people, a
  message, email or not; "Save and open…" asks "Open early access to <product> for <n> members and email them?"; an
  offer's facts and claims; edit; close: asks first). `#community` and `?tab=community` open it.
- **Walk-ins:** `<staff-walkins>` in Today's bookings (perm `checkin`), under the sign-ups: each of today's events with "Add
  a walk-in" (a member code typed, or "Scan their card" with `LairScan`), the app's words under the event.
- **My Lair:** an "Early access" card on Home (`renderOffers()`, `[data-home-offers]` after the held places): picture, name,
  price, "Just for you until Sun 18 Oct, 6pm", "Gobgob saved you one before anyone else." (or "up to N"), the staff's
  message, the options (chips), How many (a stepper, up to what they can still buy and the units left), "Buy now · $438"
  (claims, then goes to the checkout link), "Limit 2 a person · 6 left. Buy now takes you to a checkout made for your
  account. Pay within 48 hours, or it goes back for someone else."; waiting: "Waiting for payment 2 × <product>: $438" with
  "Pay now · $438" (their link) and "Pay by <when>, or it goes back for someone else. The checkout is made for your account
  only."; paid: "Got it! Yours is paid for. Your receipt is in your email." (or "All 2 are paid for."); all claimed: "All
  claimed, sorry friend. They went fast."
- **LiveBackend:** `communityStats`, `communityLists`, `createCommunityList`, `updateCommunityList`, `removeCommunityList`,
  `listOffers`, `offerDetail`, `searchOfferProducts`, `createOffer`, `updateOffer`, `openOffer`, `closeOffer`, `claimOffer`
  (after `groupMembers`), `attendEvent` (after `reserveEvent`).
- **Demo:** the same methods (after the demo's `groupMembers`), with the Lair app's checks and words: a year of sample
  turnouts, a small catalogue (one product on the online store, one a draft), a "Riftbound regulars" list and an open offer
  for whoever is logged in (so My Lair shows the card), and `demoPayClaim(claimId)`, the pretend checkout. State:
  `state.community = { seededFor, turnouts, lists, offers, claims }`. GET /me's `offers` in the demo's `me()`.

## 9. Contract notes (choices this build made)
1. **Event game spots count as turnouts** (a `table` booking with an `occurrence_id`, checked in): for wargame nights that's
   how people sign up. Plain table bookings never count.
2. **History counts:** turnouts include check-ins from before round 9 (there's no "from" date as there is for stamps).
3. **"Last seen"** is their latest turnout, not their last visit to My Lair.
4. **Total spend** is what the Lair has recorded: orders/paid since it started, plus any older orders the spend report's
   backfill read for that member. Until `read_all_orders` is granted the backfill sees Shopify's last 60 days, so long-time
   customers' totals can be low. The Community list doesn't start backfills itself.
5. **Who an offer is for is copied when it's saved** (list members and people picked), so later changes to the list don't
   change a live offer by themselves; editing the offer's list or people does. People with a claim always stay on it.
6. **Members only:** people need a Lair member record (they've used My Lair or booked while logged in) to be on an offer;
   the staff picker refuses others with a toast.
7. **Opening later:** `opens` in the future makes it `scheduled`: members see it from then, and the email (if ticked) goes
   on the first maintenance run after it opens (within 10 minutes).
8. **Walk-ins over capacity** aren't refused (staff decide at the door): the answer's `notice` says it's over.
9. **No inventory reservation in Shopify** (`reserveInventoryUntil` left out): units are held by the Lair, against the
   offer's own total. If the product is also on sale at the POS or online, Shopify's stock isn't held for claims. Hide it
   from the online store and keep the allocation's stock aside until early access ends (the warning says the first part).
10. **Emails** go to the Lair profile email, else the verified Shopify account email (read when they open My Lair).
11. **A claim's price** is the variant's price in Shopify when they claim (Shopify prices the draft order line itself);
    the offer keeps the price it was saved with for showing.

# Lair app API: round 4 (3 Oct 2026, mid-morning)

This file lists **changes only**. It sits on top of these two files, both in
`/tmp/claude-0/-home-claude-dice-goblin-lair/5bc2a993-35ba-546f-9be1-8d4523d86a25/scratchpad/`:
- `lair-api-contract.md` (the base)
- `lair-api-contract-v3.md` (round 3)

Where this file disagrees with either of them, **this file wins**.

Conventions:
- Money is in cents unless a field says dollars. Times are epoch ms.
- "Logged in" means the app proxy sent `logged_in_customer_id`.
- "Staff" means a customer tagged `staff`.
- "Today" means the Lair day (`LairTime.key(now)` in Pacific/Auckland).

Every route that the theme calls needs a matching **DemoBackend** method and a **LiveBackend** method in `assets/lair-core.js`.

The owner (Mo) made these decisions this morning. Don't reopen them.

## 0. Decisions in one screen
1. **Pay at the counter is the default for everything.** That covers table bookings, walk-ins, GM game seats, "join every session", event joins and Warhammer game spots. You reserve, it's locked in, it shows in My Lair, and on the day you show your code and pay at the counter.
   - The only exception is an event where staff chose online payment (section 2).
2. **Dice:**
   - No daily roll.
   - You earn one roll per $20 spent. Rolls stack and never expire.
   - Each "1" on the face pays $1 store credit: faces 1, 10, 12 to 19 pay $1, and 11 pays $2.
   - A natural 20 pays $20 store credit.
   - No % discount codes from dice.
   - The home page d20 stays just for fun.
3. **Soft reserves.** An event's tables are marked for that event on the booking page but stay bookable by anyone. Examples: Warhammer night, Pokémon, TCG nights, the painting tables. Staff can lock them for special events.
4. **Session passes.** Staff issue them, for example "Warhammer league: 10 sessions" or "Gift pack: 10 sessions".
   - One session covers one person's table fee, up to the standard table price.
   - The holder pays any difference: the $15 room costs $5 more, and a GM game still costs its GM fee.
   - Passes cover table sessions only. They don't cover event entry fees, products or store credit.
   - Every pass has its own code.
5. **Fun codes** replace `NAME-1234` and `DGC-<id>` everywhere: tickets, seats, event joins, member cards and passes. All codes look like `SJ-OWLBEAR-17` (section 1).
6. **POS "Today" roster.** It lists today's games, events and table bookings with names. Tap a person ("Are you Sam?") to check them in, and the amount lands in the POS cart. Scanning a code jumps straight to that person.
7. **Self-serve tab in My Lair.**
   - Customers scan a product barcode or QR code with their phone, or pick from a small menu of drinks, snacks and ice cream.
   - They "add it to their tab".
   - At the counter, staff scan their member code, the tab's items go into the POS cart, and they pay.

## 1. Codes
- **Format:** `II-WORD-N`, for example `SJ-OWLBEAR-17`.
  - `II` is the person's initials:
    - Normally the first letter of the first word of their name plus the first letter of the last word, after stripping accents, so "Zoë van der Berg" becomes `ZB`.
    - One word only: its first two letters, so "Sam" becomes `SA`.
    - No usable letters: `DG`.
  - `WORD` is a random word from the list in the appendix.
  - `N` is a d20 roll, 1–20, with no leading zero. If a code can't be found within 40 tries, use 21–99.
- **The same code** is the QR content, the text printed under the QR, and what staff type in. The QR uses upper case with dashes.
- **Matching** ignores case, spaces, dashes, dots and underscores, so `sj owlbear 17`, `SJOWLBEAR17` and `Sj-Owlbear-17` all match. The lookup key is the code reduced to `[A-Z0-9]`.
- **Unique across every kind of code.** One table holds them all: `codes (key TEXT PRIMARY KEY, code TEXT, kind TEXT, target_id TEXT, created_at INTEGER)`, where kind is one of `booking`, `join`, `member` or `pass`.
  - Never reuse a code.
- **Who gets what code:**
  - Bookings and seats: the booker's name.
  - Event joins: the joiner's name.
  - Passes: the holder's name, or `DG` if there's no holder.
  - Members: their name the first time a member record is created. It's permanent: it doesn't change when they rename themselves. Staff can issue a new one with `POST /members/:customerId/new-code` (staff only), which returns `{ code }`.
- **Legacy:**
  - Old live refs `GOB-XXXXXX` must keep working at check-in, with or without the dash.
  - `NAME-1234` and `DGC-<id>` never went live. Drop them, and update any demo data that uses them.
- **Field names:**
  - The code is still called `ref` on bookings, seats and joins.
  - Members get `member.code` in place of `member.card`.
  - Passes have `pass.code`.

## 2. Payments
- **Table bookings, walk-ins, GM seats, "join every session" and event game spots** never take payment online.
  - Ignore `pay` on these routes and treat it as `'day'`. Never return a `checkoutUrl` for them.
  - The `lair_pay_online` theme setting and `rules.payOnline` no longer affect them.
- **Event joins** follow the event's `payment`:
  - **Metaobject field:** `lair_event.payment`, a single-line text with choices `In store`, `Online` and `Online or in store`. An empty value means `In store`.
  - **Read it as:**
    - `/^online or/i` means `'either'`
    - `/^online$/i` means `'online'`
    - anything else means `'store'`
  - **Theme:** gets it from Liquid as `event.payment` with the values `'store'`, `'online'` or `'either'`. The `lair-config` snippet maps it.
  - **`'store'`:** the join is confirmed straight away and paid at the counter. `pay` is ignored.
  - **`'either'`:**
    - The join takes `pay: 'now'|'day'`, with `'day'` as the default.
    - `'now'` means held, a `checkoutUrl`, and a hold that lapses after `HOLD_MINUTES`. The orders/paid webhook confirms it (the existing pay-now machinery).
    - If Shopify can't make the checkout, the join is confirmed as pay at the counter with a notice, as before.
  - **`'online'`:**
    - The join is always held with a `checkoutUrl`. It's confirmed only when paid, and released if the hold lapses.
    - If Shopify can't make the checkout, **refuse** the join with 503 and the message "Online payment isn't working right now. Call us and we'll hold you a spot."
  - **No entry fee, or $0:** no payment of any kind, and `pay` is ignored.
- **Event game spots** (`POST /events/:id/reserve`) follow the same `payment` rules.
  - The amount is people × the event's `entry_fee` when one is set, otherwise people × the room price.
- **Paid online means locked in.** If the person cancels a join or spot they paid for online:
  - the place is freed
  - it's flagged `refund: 'ask'` for staff to decide
  - the response notice is "Your spot is cancelled. You paid online, so have a chat with us about a refund."
  - If staff or the GM cancel the event or game, it's `refund: 'due'`, as before.
  - Staff mark it refunded with `refunded: true` (v3).
  - The field is `refund` with the value `null`, `'ask'`, `'due'` or `'done'`. Use that one name and those values everywhere: backend, DemoBackend and UI.
- **Floor:** `features.payOnline` now only means "Shopify checkout is working" (`shopify.configured`). The theme uses it only for events whose payment is `'online'` or `'either'`.
- **Wording**, everywhere a booking, seat or join is pay at the counter: "Pay at the counter when you arrive. Show your code and we'll ring it up."

## 3. Soft reserves
- **`lair_event.tables`** (key unchanged; the admin name changes to "Tables reserved") is **soft** by default.
  - Anyone can still book those tables during the event: the public page, GMs and staff alike.
- **New metaobject boolean `lair_event.lock_tables`** ("Lock these tables"). When it's `true`, the tables are hard holds, exactly as v3 `tables` worked: blocked for everyone except staff. An empty value means `false`.
  - In the theme, it reaches Liquid as `event.lockTables` (true or false).
- **Game spot tables** (`game_tables`) are soft-reserved during the event as well, even when they aren't listed in `tables`.
- **Floor:** every `eventHolds[]` item gains `soft: true|false` and `title`, the event title. Soft holds never make a table unavailable.
  - Check bookings, GM games and openings against **locked** holds only.
- **Theme:**
  - **Table picker:** a soft-held table shows a small label with the event's name and a note, but it can still be picked.
  - **Summary of the chosen booking:** says it once, along the lines of "Heads up, friend: Warhammer & other wargames has dibs on T14 from 6pm. You can still book it, but expect armies nearby."

## 4. Session passes
**Data:**
- `passes (id, code, label, sessions_total, sessions_used, cover INTEGER, customer_id, holder_name, holder_email, note, price_paid INTEGER, created_at, created_by, expires_at, status)`
  - `status` is `'active'` or `'void'`.
  - `cover` is in cents. It defaults to `rules.prices.table` when the pass is made, which is $10 today.
- `pass_uses (id, pass_id, booking_id, people, covered, at, by, undone_at)`

**What one session covers:** one person's table fee, up to `cover`.
- **Table booking or walk-in:** the per-person price is the room price.
  - Covered = min(cover, room price) per person.
- **GM seat:** the table part only. The table part per person is the seat price minus the GM fee.
  - Covered = min(cover, seat price − gmFee) per person, so the GM fee is still paid.
- **Event game spot:** covered = min(cover, spot price per person).
- **Event joins (entry fees):** not covered.
- **Anything already paid:** not covered.
- **Number of sessions used** = min(people still unpaid, sessions left).

**When it's used.** Uses are recorded at check-in, never at booking time, so a no-show doesn't burn a session.
- A booking can carry a pass to use, saved as `passId` on the booking. Two things set it:
  - the member chose "use my pass" when booking (`usePass: code` on `POST /bookings` or `POST /events/:id/reserve`), or
  - staff applied one.
- At check-in (`POST /checkin`, `POST /pos/checkin`):
  - `pass` may be a code, `'none'` or left out. Left out means use the booking's saved pass, if any.
  - When a pass applies and has sessions left, record a use. The response then carries `pass: { code, label, used, left, covered }`, and `due` is what's left after the pass.
  - A void or expired pass is skipped with a `notice`.
- **Undo:** `POST /passes/uses/:useId/undo` (staff) gives the sessions back and restores the booking's due.

**Staff routes:**
- `POST /passes { label, sessions (1–100), customerId?, holderName?, holderEmail?, note?, pricePaid? (dollars), expires? ('YYYY-MM-DD'), cover? (dollars) }` returns `{ pass }`.
  - If `holderEmail` matches a known member, link that member.
  - A pass needs `customerId` or `holderName`.
- `GET /passes?q=&status=active|void|all` returns `{ passes: [pass] }`.
  - It searches label, holder name, holder email and code.
  - Newest first, up to 100.
- `POST /passes/:id/update { label?, sessions?, note?, expires?, status?, customerId?, holderName?, holderEmail? }` returns `{ pass }`.
  - `sessions` can't be set below the number already used.
- `POST /passes/:id/apply { bookingId }` saves the pass on a booking for its check-in.

**Pass view:**

```
{
  id, code, label,
  sessionsTotal, sessionsUsed, sessionsLeft,
  cover,
  holder: { customerId, name, email },
  note,
  pricePaid,
  expiresAt,
  status: 'active' | 'void' | 'expired' | 'used',
  createdAt,
  uses: [{ id, bookingId, ref, people, covered, at, undone }]   // staff only
}
```

**Members:**
- `GET /me` adds `passes`: their passes that are active or used up in the last 30 days, each as `{ code, label, sessionsTotal, sessionsLeft, cover, expiresAt, status }`.
- `POST /me/passes/claim { code }` (logged in) links an unlinked active pass to them and returns `{ pass }`. The errors are:
  - 404 "No pass with that code. Check it and try again, friend."
  - 409 "That pass already belongs to someone. Ask us at the counter."
- `usePass` on `POST /bookings` (`kind` table or gm-seat) and on `POST /events/:id/reserve`: the code of a pass linked to the logged-in member. Staff may use any active pass.
  - For anyone else, 403 "That pass isn't yours. Ask us at the counter."
  - The response's booking carries `pass: { code, label, sessionsLeft }`.

## 5. Dice
- **`POST /roll`**
  - With `{}`, `{ kind: 'fun' }`, or when not logged in, it returns `{ roll }` only.
  - **`{ kind: 'spend' }`** (`'bonus'` is accepted as an alias), logged in, uses one roll:
    - The prize is $1 store credit for each digit "1" in the face, so 1, 10 and 12–19 pay `amount: 100` and 11 pays `amount: 200`.
    - A 20 pays `amount: 2000` ($20).
    - Anything else pays nothing.
    - It returns `{ roll, kind: 'spend', prize: null | { kind: 'credit', amount, status }, message, rolls }`.
    - Messages, in Gobgob's voice:
      - "Two ones! $2 store credit, friend."
      - "Natural 20! $20 store credit is yours."
      - "A 1 on the face: $1 store credit."
      - "No ones this time. Spend $20 for another go."
  - `{ kind: 'daily' }` returns 410 "The daily roll has retired. Every $20 you spend earns a roll."
  - No rolls left returns 409 "No rolls yet, friend. Every $20 you spend earns one."
- **Store credit:** `storeCreditAccountCredit`, as in v3. If it fails, the prize is still saved with `status: 'pending'` and the message ends "Show this screen at the counter to claim it."
  - Pending prizes appear in `GET /members?q=` (staff) as `pendingPrizes`.
  - Staff mark one done with `POST /prizes/:id/done`.
- **`rolls`** is `{ available, toNext, per: 2000 }`.
  - `bonus` mirrors `available` so older clients keep working.
  - Remove `daily` everywhere.
- **`prizes`** is `[{ id, kind: 'credit', amount, status: 'added'|'pending'|'done', roll, at }]`, the last 10.

## 6. Self-serve tab (My Lair)
- **`GET /me`** adds `tab`. It's today's tab or `null`:

  ```
  {
    id, day,
    items: [{ variantId, title, variantTitle, price, qty }],
    total,
    status: 'open' | 'in-cart' | 'paid',
    updatedAt
  }
  ```

  - `variantId` is the numeric Shopify variant id as a string.
  - `price` is in cents, taken from the theme's catalogue.
  - The amount at the counter always comes from Shopify's own prices in POS.
- **`POST /tab { items }`** (logged in) saves today's tab, replacing its items, and returns `{ tab }`.
  - Rules: up to 30 lines, `qty` 1–20, `variantId` must be `/^\d{1,20}$/`, `price` 0–100000, titles trimmed to 80 characters. Identical variantIds are merged.
  - An empty `items` deletes the open tab.
  - If today's tab is `'in-cart'`, it returns 409 "Your tab is at the counter already. Pay for that one, then start a fresh one."
  - If today's tab is `'paid'`, a new tab starts.
- **`POST /tab/clear`** deletes today's open tab.
- **Theme catalogue:**
  - The menu comes from a `product_list` setting on the My Lair section, "Tab menu". Its default handles are `drinks`, `snacks-1`, `ice-cream` and `poweraid`.
  - Liquid renders a JSON catalogue: products, their variants, and each variant's `barcode`, `sku`, price, title and image.
  - When the camera scans a code:
    1. **Look it up in the catalogue** by barcode or SKU first.
    2. **Then try the QR URL:** a product URL `…/products/<handle>` becomes `/products/<handle>.js`.
    3. **Then the store's predictive search:** `/search/suggest.json?q=<code>&resources[type]=product&resources[options][fields]=variants.barcode,variants.sku`, followed by `/products/<handle>.js`, matching the variant by barcode.
    4. **If nothing matches:** "Gobgob doesn't know that one. Pick it from the menu instead."
  - The scanner is a shared helper, `assets/lair-scan.js`, exposing `window.LairScan.open({ formats, onCode })`.
    - It uses `BarcodeDetector` when present.
    - Otherwise it lazy-loads the MIT `barcode-detector` polyfill from `https://cdn.jsdelivr.net/npm/barcode-detector@3/dist/iife/polyfill.min.js` (pin an exact version), so iPhones work.
    - It reads EAN-13, EAN-8, UPC-A, UPC-E, Code 128 and QR.

## 7. POS extension routes
The Worker serves these, not the app proxy. Auth is the v3 POS session-token JWT.

- **`GET /pos/today`** returns `{ day, now, groups }`:
  - Each group is `{ key, kind: 'game'|'event'|'tables', title, start, end, tables, rows }`.
  - Each row:

    ```
    {
      id, type: 'booking'|'join',
      ref, name, people, tables, start, end,
      status, arrivedAt,
      paid, amount, covered, due,
      customerId,
      pass: { code, label, left } | null,
      refund,
      note
    }
    ```

  - **`game`:** one group per GM game session today. Title "<game title> · GM <gm name>". Its rows are the seats, and the GM isn't a row.
  - **`event`:** one group per event occurrence today. Its rows are joins plus the event's game-spot bookings.
  - **`tables`:** one group, titled "Table bookings", holding all other table bookings and walk-ins for today.
  - Groups are ordered by start time. Cancelled rows are left out. No-shows stay, with their status.
- **`POST /pos/scan { code }`** looks the code up without checking anyone in:
  - Booking or join: `{ type: 'booking'|'join', row, group: { key, kind, title, start } }`.
  - Member:

    ```
    {
      type: 'member',
      member: { customerId, name, code },
      rows,      // their rows today, across every group
      tab,       // today's tab or null
      passes     // active passes
    }
    ```

  - Pass: `{ type: 'pass', pass }`.
  - Legacy `GOB-…` refs work.
  - An unknown code returns 404 "No booking, member or pass with that code."
- **`POST /pos/checkin { id, type, pass?, force? }`** (or the legacy `{ code }`) marks the person arrived and applies a pass (section 4).
  - It returns `{ row, lines, customer: { id } | null, pass, notice }`.
  - Each line: `{ title, price: "15.00", quantity: 1, taxable: true, properties: { _booking: ref } }`.
    - The title says what it is, for example "Table fee: SJ-OWLBEAR-17 (T4, 3 people)", "GM seat: Curse of Strahd (SJ-OWLBEAR-17)" or "Event entry: Pokémon TCG league (SJ-OWLBEAR-17)".
    - When a pass covered part of it, the title adds "(pass covered $20)".
  - `lines` is empty when nothing is due.
  - Checking in someone already arrived is fine: it returns the same lines (due may be 0).
- **`POST /pos/checkin-member { customerId }`** checks in all of that member's rows today. It returns `{ rows, lines, customer, notices }`.
- **`POST /pos/tab/:id/added`** marks the tab `'in-cart'` and returns `{ tab }`.
  - The extension adds each item with `cart.addLineItem(Number(variantId), qty)` and then the line property `_tab: <tab id>`.
- **orders/paid webhook:**
  - `_booking` on a POS order marks that booking or join paid (v3).
  - `_tab` marks that tab `'paid'`.
  - Spend still counts for the order's customer, including POS orders.

## 8. Staff web page
- `POST /checkin { code }` or `{ id, type }` takes `pass?` and `force?` and returns the same shape as `POST /pos/checkin` (`row`, `pass`, `notice`; `lines` can be omitted).
- **Staff floor bookings** gain:
  - `pass: { code, label, left } | null` (the saved pass)
  - `covered`
  - `due`
  - `refund` (section 2)
- `GET /members?q=` matches member codes too and adds `code` and `pendingPrizes`.

## 9. GET /me (logged in), all together
These are the v3 fields with these changes:
- `member.code` replaces `member.card`.
- `rolls: { available, toNext, per }`, with `bonus` kept as a mirror.
- `prizes` has statuses.
- New: `passes` and `tab`.
- Every booking, seat and join view gains `payment: 'store'|'online'` (how it is or will be paid) and `refund`, plus `pass` and `covered` for bookings and seats.

## 10. What the coordinator does (agents don't)
These are left to the coordinator, not the agents:
- Store changes: the new metaobject fields `payment` and `lock_tables`, renaming "Tables held" to "Tables reserved", the Warhammer event's description, and any data.
- Pushing, deploying, theme uploads, and merging the branches.

**Agents must not:**
- write to the Shopify store
- push to GitHub
- upload theme files
- run anything against the live Worker

## Appendix: word list for codes
Use this exact list in the backend and in the DemoBackend.

```js
const CODE_WORDS = [
  'GOBLIN','KOBOLD','OWLBEAR','MIMIC','GOLEM','WYVERN','DRAGON','DRAKE','HYDRA','KRAKEN','GRIFFIN','PHOENIX',
  'UNICORN','PEGASUS','BASILISK','CHIMERA','SPHINX','TROLL','OGRE','GNOME','PIXIE','SPRITE','FAERIE','BROWNIE',
  'IMP','GREMLIN','BUGBEAR','HOBGOBLIN','YETI','GHOST','BANSHEE','WISP','DJINN','GENIE','SELKIE','KELPIE',
  'SATYR','CENTAUR','MINOTAUR','CYCLOPS','HARPY','GORGON','KITSUNE','TANUKI','KAPPA','TENGU','DRYAD','TREANT',
  'WEREWOLF','MUMMY','ZOMBIE','SKELETON','SLIME','OOZE','BLOB',
  'BADGER','OTTER','FERRET','HEDGEHOG','RACCOON','WOMBAT','PLATYPUS','AXOLOTL','NEWT','TOAD','FROG','GECKO',
  'BEETLE','MOTH','SNAIL','CRAB','SQUID','OCTOPUS','NARWHAL','WALRUS','PENGUIN','PUFFIN','RAVEN','MAGPIE',
  'OWL','BAT','FOX','WOLF','BEAR','BOAR','STAG','HARE','LLAMA','ALPACA','CAPYBARA','PANDA','YAK','GOAT',
  'MOOSE','LOBSTER','TORTOISE','TURTLE','LEMUR','SLOTH','KOALA','QUOKKA','MEERKAT','KITTEN','PUPPY',
  'KIWI','KEA','KAKA','TUI','WETA','MOA','TUATARA','KAKAPO','PUKEKO','TAKAHE','KOKAKO','FANTAIL','MOREPORK',
  'RURU','KERERU','WEKA','PAUA','KUMARA','PAVLOVA','JANDAL','LAMINGTON','FEIJOA','PIKELET',
  'MEEPLE','DICE','POTION','SCROLL','WAND','STAFF','SWORD','SHIELD','LANTERN','TORCH','MAP','COMPASS','CROWN',
  'GOBLET','CHEST','RUNE','TOME','AMULET','RING','CLOAK','BOOTS','HELM','AXE','BOW','ARROW','DAGGER','HAMMER',
  'LUTE','HARP','DRUM','QUILL','INKPOT','CANDLE','KEY','ROPE','BACKPACK','CAULDRON','BROOM','MIRROR','ORB',
  'GEM','RUBY','OPAL','AMBER','JADE','PEARL','TOPAZ','GARNET','COIN','DOUBLOON','TREASURE','BANNER','TOKEN',
  'PAWN','ROOK','KNIGHT','BISHOP','QUEEN','KING',
  'PIE','PRETZEL','MUFFIN','SCONE','CRUMPET','PANCAKE','WAFFLE','DUMPLING','NOODLE','PICKLE','TURNIP','RADISH',
  'CARROT','MUSHROOM','TRUFFLE','CHEESE','BISCUIT','COOKIE','TOFFEE','FUDGE','NOUGAT','TOASTIE','NACHO','TACO',
  'BAGEL','DONUT','CUPCAKE','PUDDING','JELLY','CUSTARD',
  'QUEST','SAGA','LEGEND','RIDDLE','SPELL','HEX','CHARM','JINX','OMEN','LOOT','CRIT','BOSS','DUNGEON','TAVERN',
  'CASTLE','TOWER','CAVE','LAIR','PORTAL','MAZE','VAULT','CRYPT','SWAMP','FOREST','MEADOW','GROTTO','ISLAND',
  'VOLCANO','GLACIER',
  'EMBER','SPARK','FROST','THUNDER','STORM','GUST','MIST','SHADOW','STAR','MOON','COMET','NOVA','AURORA',
  'ECLIPSE','RAINBOW','BLIZZARD',
];
```

## 11. Split the bill (added 11:36, Mo)
Mo's words: people who book a table can choose to split the payment with friends. The amount stays on the booker's own account, not everyone else's, and staff can add other people's accounts at the counter for the other payments.

**Booking**
- `POST /bookings` with `kind: 'table'` accepts `split: true`. The booking is saved with it, and the booking views show `split`.
- The booking and what's owed still live only on the booker's account and in the booker's My Lair. Friends don't get a copy.
- On the booking page this is a simple toggle, "Split the bill at the counter". The ticket says: "Splitting the bill? Each friend can pay their share at the counter."

**Partial payments**
- Bookings and joins gain `paidAmount`, in cents: the total paid so far.
- `due` = max(0, amount − covered − paidAmount).
- `paid` becomes true when `due` reaches 0 and something was owed.
- Every row view adds `paidAmount` and `payments`, where `payments` is `[{ amount, customerId, name, at }]` (staff and POS only).
- A new table, `payments (id, booking_id, kind 'booking'|'join', order_id, line_id, amount, customer_id, at)`, records each payment. A pair of `order_id` and `line_id` is only ever counted once, so a repeated webhook doesn't double up.

**orders/paid webhook**
- Each line with `_booking` adds its paid amount to that booking's or join's `paidAmount`.
- The paid amount is the line's price × quantity, minus that line's discount allocations.
- The order's customer is recorded as the payer, and their spend counts as usual. This means each friend who pays with their own member code attached earns their own dice rolls.

**POS**
- `POST /pos/share { id, type, amount? }` returns `{ row, line }`.
  - `line` is one custom sale for `amount` cents, capped at `due`. With no amount, it's the per-person share: `ceil(amount ÷ people)`, capped at `due`.
  - The title reads like "Table fee share: SJ-OWLBEAR-17 ($10 of $40 left)".
  - The line's properties are `{ _booking: ref, _share: '1' }`.
  - Staff can scan the friend's member code first (`/pos/scan` member) so the cart's customer is the person paying that share.
- **Split flow in the extension** (person view):
  1. "Split the bill" offers per-person shares, with how many people are left to pay, or a custom amount.
  2. For each share, staff can say who's paying: scan their code or search for them. Then "Add $X to cart", then pay on the Verifone.
  3. Reopening the person shows what's left, once the payment webhook has landed. The view says "Waiting for the last payment…" if it hasn't arrived yet. Refresh by re-scanning or pulling the row again.
- Checking in with the normal full line still works as before: one line for everything due.

**Staff page and My Lair**
- Both show "Paid $X of $Y" and "$Z left" when part of the bill is paid, plus who paid (staff only).
- Booking cards show a "Splitting the bill" tag when `split` is set.

# Lair app API: round 7 (6 Oct 2026)

**Changes only.** This round sits on top of `lair-api-contract-v6.md`, then v5 (with v5.1), v4, v3 and the base contract (v1). Where they disagree, this file wins. Money is in cents (a field that takes dollars says so), times are milliseconds since 1970 (UTC), and days are Lair days (Pacific/Auckland) unless a field says otherwise. Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx status.

**Where things live:**
- Backend: `main` of dicegoblinnz/Dice-Goblin-Lair at 44b5175 (production). Round 7 work goes on `r7-backend-a` and `r7-backend-b`.
- Theme: `dice-goblin-2-theme` of dicegoblinnz/Dice-Goblin-website at 5fdeb84 (the preview, 166589005927). Round 7 work goes on `r7-shell`, `r7-mylair`, `r7-library`, `r7-staff-admin` and `r7-staff-games`.
- Every route needs a `LiveBackend` method in `assets/lair-core.js` and a demo method in `assets/lair-demo.js` that behaves like this contract, errors and messages included. Section 18 says who writes which, and where in the file.

**Owners.** Every section names its backend owner, **[A] backend-a** or **[B] backend-b**, and the theme agents that use it. The 17 decisions in MO.md are settled. Where this contract had to choose something MO.md didn't settle, the rule is marked ★, and section 19 lists those choices for the coordinator to check.

---

## 0. Map

| MO.md decision | Section | Backend | Theme |
|---|---|---|---|
| 3 Mobile number required | 1 | A | shell (forms), mylair (profile) |
| 16 Player profile | 2 | A | mylair; staff-admin and staff-games show it |
| 4 Welcome roll → roll codes, "Got a code?" | 3 | A | staff-admin (Codes tab), mylair (Wallet) |
| 15 Loyalty card always refreshing | 4 | A | mylair |
| 5, 6 Birthdays, gift contents, claimed gifts | 5 | A | mylair (Wallet), staff-admin (Members) |
| 7 Library holds, loans, scanning | 6 | A | library (mylair gives it a container) |
| 8 Tab scanner | 7 | A | library |
| 9, 12, 13 Picking customers | 8 | B | staff-admin, staff-games |
| 9 Groups and passes | 9 | B | staff-admin; mylair shows group passes |
| 10 Events editor | 10 | B | staff-admin |
| 12 Staff TTRPG sessions, GM invites | 11 | B | staff-games |
| 13 Seats: regulars, players, reserved seats | 12 | B | staff-games |
| 1, 2, 11, 14, 17 Header, logos, calendar, shop, menu | 17 (theme-only rules) | none | shell, mylair |

Sections 13 to 16 list every Admin API operation, the migrations, the emails and the backend merge rules. Section 17 is theme-only rules everyone shares, section 18 the theme modules, section 19 the open points.

---

## 1. Mobile numbers [A] (theme: shell for the forms, mylair for the profile)

> "We need to make mobile mandatory for booking tables and games and events etc."

### Rules
- **Required** on every customer booking:
  - `POST /bookings` with `kind: 'table'`, unless staff send `staffOverride: true`;
  - `POST /bookings` with `kind: 'gm-seat'` (members and guests alike);
  - `POST /games/:id/join-series` ("Save my seat every week");
  - `POST /events/:occurrenceId/join` (event sign-ups);
  - `POST /events/:occurrenceId/reserve` (event game spots).
- **Not required** on anything staff make: walk-ins (`kind: 'walkin'`), table bookings with `staffOverride: true`, `POST /games/:id/players` (section 12), staff-made sessions (section 11), and the library and tab routes.
- The field keeps its name on these routes: **`phone`**. In the profile it's `mobile` (section 2).
- **Valid:** take out spaces, dashes, dots and brackets, then either
  - a New Zealand mobile: `/^(?:\+?64|0)2\d{7,9}$/` (021 123 4567, 027 1234 5678, +64 21 123 456), or
  - an overseas number: `/^\+[1-9]\d{6,14}$/` that doesn't start `+64` (a visitor's mobile).
  New Zealand landlines (03, 04, 06, 07, 09, or +64 then not 2) are refused: Mo asked for a mobile.
- **Stored** as typed: trimmed, runs of spaces made one, at most 20 characters (`bookings.phone`, new `event_joins.phone`). Comparing two numbers uses their digits with a leading `0` read as `+64`.
- **Saved to the profile:** when a logged-in customer books for themselves (none of the staff cases above) and their profile has no mobile or a different one, `members.mobile` becomes this one.
- A weekly regular's later seats (made by maintenance, `seatSeriesMember`) take their profile mobile.
- Round 6's "optional phone, up to 30 characters" on game seats retires with its message.

### Messages (422)
- Missing: **"Add a mobile number so we can reach you on the day."**
- Not a mobile: **"That mobile number doesn't look right. Try one like 021 123 4567."**

### Where it shows
- Staff: floor bookings already carry `phone`; staff sign-up views (`staffJoinView`: the floor's `joins`, check-in, `/bookings/:id/update` on a sign-up) add `phone`; members add `mobile` (section 2).
- The GM's "New player for …" email already lists Phone.

### Theme (shell)
- The table booking, TTRPG join (lair-join.js, guests and members, "Save my seat every week" too), event sign-up and game spot forms: one field labelled **Mobile**, `type="tel"`, `inputmode="tel"`, `autocomplete="tel"`, `required`, with the hint "So we can reach you on the day." The same check in the browser, with the same two messages, before sending.
- Pre-fill: the member's `profile.mobile` from GET /me when the page has it, else `customer.phone` from lair-config, else empty. Never overwrite what they've typed.

### Demo (shell)
The demo's `createBooking` (tables, not walk-ins or `staffOverride`), `joinGame`, `joinSeries`, `joinEvent` and `reserveEvent` apply the same rule and messages, and save a logged-in customer's new number on their demo member as `member.mobile` (the field mylair's demo profile reads).

---

## 2. Player profile [A] (theme: mylair; staff-admin and staff-games show it)

> "let players have their own profile as well. Not just gms, so maybe call it all player profile and have the gm section be another box underneath it"

### Fields

| Field | Rule |
|---|---|
| `name` | Their name, up to 80 characters (round 3) |
| `firstName` | Up to 40 (round 3) |
| `email` | Their Lair email (round 3) |
| `mobile` | Section 1's rule, or `''` to clear it |
| `birthday` | `'MM-DD'`, or `''` to clear it (round 3) |
| `pronouns` | Free text, up to 30 characters (the form suggests she/her, he/him, they/them), `''` clears |
| `favouriteGames` | A list of up to 8 names, each 1 to 40 characters, trimmed, repeats (ignoring case) dropped; `[]` clears |
| `about` | "About me", up to 300 characters, line breaks kept, `''` clears |

Longer text is cut to its limit and a 9th game is dropped: the form's `maxlength` stops both before they're sent.

### Routes
- **`POST /me/profile`** (logged in) takes any of the fields above. Only the fields sent change. Returns `{ member, profile }`. Errors as round 3 (401 "Log in to save your details.", the email and birthday messages) plus section 1's mobile message.
- **`GET /me` adds `profile`:**
  ```
  profile: { name, firstName, email, mobile, birthday, pronouns, favouriteGames: [], about, updatedAt }
  ```
- **The GM profile stays its own block**, unchanged: `POST /gm-profile { name, bio }` and GET /me's `gmProfile`.

### Who sees what
- **The member:** all of it.
- **Staff:** all of it. GET /members items add `mobile`, `pronouns`, `favouriteGames` and `about`, and so does `GET /members/:customerId` (section 5).
- **The GM of a session (and staff), in the game's `players`** (the floor's games for their GM and staff, GET /me's `games`): each player adds `member` (their seat is on an account), `regular` (a weekly regular's seat), and the first player of a seat on an account adds that account's `pronouns`, `favouriteGames` and `about`. A GM never sees a player's mobile, email or birthday on the board; their "New player" email keeps the phone, as now.
- **Anyone else:** nothing. The public board shows no names.
- The profile form says so (mylair): "Your GM sees your pronouns, favourite games and about me. Your mobile and birthday are just for the Lair team."

### Stored
`members.mobile`, `pronouns`, `favourite_games` (JSON list), `about`, `profile_updated_at` (migration 17).

### Demo (mylair)
GET /me's `profile` comes from the demo member (the same object staff see), `saveProfile` takes the new fields with these limits.

---

## 3. Codes: roll codes and "Got a code?" [A] (theme: staff-admin for the Codes tab, mylair for the Wallet)

> "make the welcome roll a single use coupon of sorts and then we can just give it to all our customers."

### Rules
- **No more automatic welcome roll.** From round 7, nothing gives a member a welcome roll by itself: `touchMember` and the profile form stop calling `welcomeRoll`. ★ Welcome rolls already given since round 6 went live stay: they're rows in `loyalty_grants`, they still count, and `loyalty.rolls.earned.welcome` stays in the shape. Only Mo, staff and testers have had one (members are only made on the preview's Lair pages), so it's a handful.
- **Roll codes:** staff make them on the staff page. Each has:
  - a **code**, typed or made by the Lair. Typed: 4 to 24 letters, numbers or dashes, kept in capitals ("WELCOME", "GOBGOB-2026"); at least 4 letters or numbers once dashes are dropped. Made by the Lair: like **GG-KOBOLD-14** (`uniqueCode('Gobgob Gift', …)`). Either way it goes in the `codes` table with kind `'roll'`, so no code of any kind is ever used twice. The text never changes: make a new code instead.
  - **rolls** per redeem, 1 to 20, default 1;
  - **once per customer**, always;
  - an optional **total limit** (1 to 100,000 redeems; none means no limit);
  - an optional **expiry**: the last day it works, until midnight Lair time;
  - **active** or **inactive**;
  - a staff **note**, up to 300 characters.
- Redeeming gives loyalty rolls: a `loyalty_grants` row with kind `'code'`, count = the code's rolls, note = the code, `created_by` = `code:<id>`. Its own row in `roll_code_uses` (unique per code and customer) keeps the once-each rule.
- Roll codes never work as tickets: check-in, the POS scan and the member search treat them as unknown ("No booking, member or pass with that code.").
- Mo makes the welcome code himself (say "WELCOME", 1 roll, no limit, no expiry) and hands it to every customer.

### Staff routes
- **`GET /roll-codes?status=active|all`** → `{ codes: [rollCode] }`, newest first. `active` (the default) leaves out inactive ones; `all` is the last 200.
- **`POST /roll-codes { code?, rolls?, limit?, expires?, note? }`** → `{ code: rollCode }`. `limit` is a number or null; `expires` is `'YYYY-MM-DD'` or null.
- **`POST /roll-codes/:id/update { rolls?, limit?, expires?, note?, status? }`** → `{ code: rollCode }`. `status` is `'active'` or `'inactive'`.

```
rollCode: {
  id, code, rolls, limit (null: no limit), uses, left (null when there's no limit),
  expiresAt (ms of the last moment it works, or null),
  status: 'active' | 'inactive' | 'expired' | 'used-up',
  note, createdAt, createdBy, lastUsedAt,
  recent: [ { customerId, name, code (their member code), at } ]   // the last 10 redeems, newest first
}
```

Staff messages:
- 422 "Codes are 4 to 24 letters, numbers or dashes, like WELCOME."
- 409 "That code's taken. Pick another, or leave it empty and Gobgob will make one."
- 422 "A code gives 1 to 20 rolls."
- 422 "The limit is how many times it can be used in all, from 1 up. Leave it empty for no limit."
- 409 "It's been used N times, so the limit can't be lower than N."
- 422 "Pick the last day it works from the calendar." / 422 "That date has already passed."
- 422 "A code is active or inactive."
- 404 "That code could not be found."
- 403 for anyone else: the staff-only words every staff route uses.

### Member route: "Got a code?"
**`POST /me/codes/redeem { code }`** (logged in): one box for pass codes, session gift codes and roll codes.
- **A pass or session gift code** (a pass nobody has claimed): exactly what `POST /me/passes/claim` does, and that route keeps working. → `{ kind: 'pass', pass, message: "Added to your wallet: <label>." }` (`pass` as the claim route's).
- **A roll code** → `{ kind: 'roll', rolls, message, loyalty }` (`loyalty` as GET /me's).
  - message: "That's 1 roll for your loyalty card. Roll it on Home!" or "That's N rolls for your loyalty card. Roll them on Home!"
- **Errors:**
  - 401 "Log in to use a code."
  - 422 "Type your code first."
  - 404 "Gobgob doesn't know that code. Check it and try again, friend." (anything else, member and ticket codes included)
  - 422 "That's a shop discount code. Use it at checkout online, or show it at the counter." (a birthday gift's HBD- product code)
  - 409 "You've used that code already, friend."
  - 410 "That code isn't working any more. Ask us at the counter." (inactive, expired or used up)
  - the claim route's 404 and 409 for passes ("No pass with that code…", "That pass already belongs to someone. Ask us at the counter."), and section 9's 409 for a group's pass
  - 429 "Too many tries in a row. Give it ten minutes, or ask us at the counter." Ten tries in ten minutes per member, shared with the claim route; a pass code counts once (call `claimPass` for it rather than counting twice).
- Session gift emails say where to redeem: `GIFT_REDEEM` becomes "Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under 'Got a code?'".

### Stored
`roll_codes`, `roll_code_uses`, and the `'roll'` rows in `codes` (migration 17).

### Demo
- staff-admin writes the demo `rollCodes`, `createRollCode` and `updateRollCode`; mylair writes the demo `redeemCode`. Both read and write `state.rollCodes` (section 18 has its shape). When it isn't there yet, both start from the same seed: one active code **WELCOME**, 1 roll, no limit, no expiry, note "The welcome roll, for every customer".
- The demo member no longer starts with a welcome roll (mylair changes the loyalty seed); the WELCOME code shows the redeem flow instead.

---

## 4. Loyalty card [A] (theme: mylair)

> "For the loyalty card we want it to be always refreshing, so after one finishes another one will be ready"

- **`loyalty` adds `card`:** the number of the card they're on, `cards + 1`. The maths doesn't change: the 10th stamp fills the card, its roll joins `rolls.available` ("rolls ready") and the next card starts at once with 0 stamps. So 23 stamps is card 3 with 3 stamps, and 2 rolls earned from cards.
- **`loyalty.rolls.earned` adds `codes`:** rolls from roll codes. `available = cards + welcome + birthday + staff + codes − used`.
- `card` is also in the staff `GET /members` items' `loyalty` and the POS member answers' `loyalty` (`/pos/scan` for a member, `/pos/member`).
- Theme words (mylair): "Card 3 · 7 of 10 stamps" and "1 roll ready". The sentence "Making a Dice Goblin account earns a welcome roll, and on your birthday there's a roll for every year you've been with us." goes from the card's description.
- Demo (mylair): the demo's loyalty object gains `codes`; GET /me's `loyalty.card` follows.

---

## 5. Birthdays and gifts [A] (theme: mylair for the Wallet, staff-admin for Members)

> "Remove the birthday rolls but let's keep tracking their birthday none the less and how long they have been with dice goblin with us."
> "I have claimed the birthday gift and it is still on my account"
> "Instead of just saying a customer has a birthday gift this year please write what it is they were gifted."

### Rules
- **No suggested rolls.** `GET /members/birthdays` keeps `suggested.rolls` for older pages, always `0`. `suggested.low` and `high` (dollars) stay. Staff can still add rolls to a gift by hand (`rolls`, 0 to 20, default 0).
- **Still tracked:** birthdays (`members.birthday`), when they became a customer (`customerSince`) and `yearsWithUs`, all shown to staff as now. Members never see a birthday-roll promise.
- **A gift's product code** has a state:
  - `'ready'`: Shopify made the code, it hasn't been used, and its 30 days aren't over;
  - `'used'`: an order (online or at the POS) carried the code;
  - `'expired'`: 30 days passed with no use;
  - `'failed'`: Shopify couldn't make the code, so they collect it at the counter.
- **A gift's state** (what the member sees):
  - `'ready'`: it has a product that's `'ready'`, or a `'failed'` product within its 30 days. My Lair shows the full card.
  - `'claimed'`: anything else. My Lair shows one line; `claimedAt` is when the code was used, when it ran out, or, for a gift with no product, when it was given. A `'failed'` product gift is no longer listed once its 30 days are over.
  - Listed in GET /me while `'ready'`, or `'claimed'` within the last 30 days, whatever year it was given in. After that it's gone.
- **How a used code is noticed:**
  1. **orders/paid:** the order's discount codes (`OrderSpend` asks for `discountCodes` and `processedAt`). A code that matches a gift's product code (ignoring case) marks that gift used, once: `product_used_at` = the order's `processedAt` (or now), `product_order` = the order's name.
  2. **Gifts made before round 7** (created before the meta key `gift-codes-from`, written on round 7's first start): one check each through `LairGiftCodeUse` (section 13). `asyncUsageCount` of 1 or more means used, with `usedAt` = when it was checked. The check runs in maintenance (up to 20 gifts a run) and on GET /me and `GET /members/:customerId` for that member's gifts (up to 5, before the no-awaits part). `product_checked_at` records that Shopify answered; a failed lookup waits 10 minutes, as other lookups do.
  3. **A code that reaches its 30 days with no recorded use** gets the same check once in maintenance, so a use the webhook missed still shows as used.

### What a gift says (one rule for staff and members)
`words` joins the parts with ", ":
- credit: "$20 store credit", or "$20 store credit (to give at the counter)" when Shopify didn't add it;
- sessions: "3 sessions on pass SJ-KOBOLD-3";
- rolls: "5 rolls" or "1 roll";
- product: its title, then the code in brackets: "(code HBD-SJOWLBEAR17, used 6 Oct)", "(code HBD-SJOWLBEAR17, until 5 Nov)", "(code HBD-SJOWLBEAR17, ran out 5 Nov)", or "(no code yet: give it at the counter)".

Dates are like "6 Oct" in Lair time, with the year when it isn't this year ("6 Oct 2025"). Mo's example reads: **"$20 store credit, 5 rolls, Riftbound – Vendetta Booster Pack (code HBD-SJOWLBEAR17, used 6 Oct)"**.

### Routes
- **Staff gift view** (the gift route's answer, `lastGift` in GET /members/birthdays, and the lists below) adds to round 5's `{ id, at, credit, sessions, passCode, rolls, product, emailed, problems }`:
  ```
  product: { title, code, status: 'ready' | 'used' | 'expired' | 'failed', expiresAt, usedAt, order } | null,
  state: 'ready' | 'claimed', claimedAt, words, note
  ```
- **`GET /members` items add `giftsThisYear: [ { id, at, words } ]`** (this Lair year's gifts, newest first). `giftedThisYear` stays.
- **`GET /members/:customerId`** (new, staff): one member, for their page. → `{ member }`: the GET /members item, plus the profile fields, plus
  - `gifts`: every gift, newest first, as the staff gift view;
  - `library: { plan, holds, atHome }` (section 6; `plan` from their Shopify tags, null without a plan).

  404 "No member with that customer ID." The staff page used `GET /members?q=<id>` for this; that still works.
- **GET /me `gifts`** (member view), listed as the rules say:
  ```
  gifts: [ { id, at, credit, sessions, rolls, product: { title, code, status, expiresAt, usedAt } | null, state, claimedAt, words } ]
  ```
- **The rolls line** (mylair): "Your 5 rolls are waiting on Home" shows only while `loyalty.rolls.available > 0`, and the number is `min(gift.rolls, loyalty.rolls.available)`.

### Stored
`gifts.product_used_at`, `product_order`, `product_checked_at`, and the meta key `gift-codes-from` (migration 17 and first start).

### Demo
mylair: GET /me's gifts with states and `words` (seed one claimed gift, used yesterday, and one ready). staff-admin: the staff views (`memberDetail`, `giftsThisYear`, the birthdays list's `suggested.rolls: 0`).

---

## 6. Library: holds, games at home and scanning [A] (theme: library; mylair gives it a container)

> "The library membership should have its own "page" like My Library and have each image of the game be displayed next to each item. And a camera scanner to help jump into the camera scanner to help book a game in and out"
> "Then make the held is until midnight on the third day"
> "a way for staff to be able to click on a board game that is collected to be able to return to shelve"

### Rules
- **Holds last until midnight at the end of the third day** after the day they're made: `until` is the very start (00:00, Lair time) of the fourth day after. Made any time Tuesday 6 Oct: `until` is 00:00 Saturday 10 Oct, which everyone reads as "midnight, Fri 9 Oct".
  - `holdUntil(time, ms) = time.at(addDays(time.key(ms), HOLD_DAYS + 1), 0)` with `HOLD_DAYS = 3`; `HOLD_UNTIL_HOUR` goes. Counting days keeps it right across daylight saving.
  - Holds made before round 7 keep their 12pm `until`. Staff putting a hold back (`status: 'held'`) gives it a fresh `until` by the new rule.
- **How a hold's `until` reads, everywhere** (the library page, My Library, the staff page, messages and emails):
  - `until` exactly at midnight Lair time is the end of the day before. Short: **"midnight, Fri 9 Oct"**. Long (emails): **"midnight on Friday 9 October"**. Weekday: **"midnight Fri"**.
  - Any other time (holds from before round 7) as round 6: "Thu 8 Oct, 12pm", "Thursday 8 October, 12pm", "Thu 12pm".
- **Games at home (loans).** A collected game is at home with the member, on loan, until it's returned. A loan is `'out'` or `'returned'`. ★ There's no due date and so no "overdue": a member keeps a game while their plan runs (Mo set no limit). Staff lists show how many days each has been out.
- **Copies on the shelf:** `available = copies − active holds − loans out`, never below 0.
- **A plan's limit counts holds and games at home:** active holds + loans out can't pass the plan's games.
- **Collected creates the loan.** Marking a hold `'collected'` makes its `'out'` loan in the same write (`hold_id` links them). Staff putting a collected hold back to `'held'` removes its loan while it's still out (it never went home).
- **Already collected:** migration 17 gives every hold that's `'collected'` today an `'out'` loan, so the games handed over in round 6 show as at home until staff mark them back on the shelf.

### Which game a scanned code is
Library copies' barcodes and SKUs are their shelf codes (DGL56-002, DGL7+-001), and every copy has its shelf code in the product metafield `custom.library_code`. One copy kept its ISBN as its barcode.
1. **Clean it:** trimmed, 1 to 40 characters of letters, numbers and `. _ - +`. Anything else: 422 "Scan the barcode on the box, or type the code on its label."
2. **Codes the Lair knows:** `library_codes` (key = `codeKey(code)`, the same letters-and-numbers key as other codes) → a variant in `library_games`.
3. **Otherwise Shopify:** `LairVariantByCode` with `barcode:"<code>" OR sku:"<code>"`. Keep a variant whose barcode, then SKU, equals the code (ignoring case). It's a library copy when its product has `custom.library_code`. Save it in `library_games` (title without " (Library)", handle, product id, shelf code, the product's featured image) and its shelf code, SKU and barcode in `library_codes`.
   - A variant that isn't a library copy: 422 "That's from the shop, not the library. Borrow games from the library shelves, friend."
   - No variant: 404 "Gobgob can't find a library game with that code. Try the code on its label, or ask at the counter." Remember the miss for 10 minutes.
   - Shopify refuses (read_products not approved yet) or is down: 503 "Gobgob can't look that game up just now. Ask at the counter and we'll sort it." Don't ask again for 10 minutes. Games the Lair already knows keep working.
4. **Holds made from a game's page also fill `library_games` and `library_codes`** (they send the variant, product, title, shelf code, handle and now the picture), so most of the library is known before read_products is approved.

### Member routes
- **`GET /library/status?ids=`** adds `out` (copies at home with members). `available` takes them off too. `nextFree` stays the soonest hold `until` when nothing's available and something's held, else null (null when every copy is at home). Adds **`atHome: { id, outAt } | null`**: the logged-in member has a copy at home.
- **`POST /library/holds`** takes an optional `image`: the game's picture from the page, up to 500 characters, either on `cdn.shopify.com` or the store's own `/cdn/shop/` path (what Liquid's `image_url` gives, like `//www.dicegoblin.nz/cdn/shop/files/…`; a `//` address is kept as `https:`). Anything else is ignored (stored as null). Its checks count loans:
  - 409 "Your plan has N games at a time, and you've got N: X reserved and Y at home. Return one or cancel a hold first." ("1 game", and say only the parts that aren't 0.)
  - 409 "Every copy is reserved or out on loan right now. It's back on the shelf by midnight Fri if nobody collects it." (some held; the weekday as above)
  - 409 "Every copy is out on loan right now. Check back soon, friend." (all at home)
- **`POST /library/scan { code, action? }`** (logged in): borrow or return a game in the Lair with the camera. `action` is `'borrow'` or `'return'`; left out, it's a return when the game is at home with them, otherwise a borrow.
  - **Return** → `{ result: 'returned', loan, library, message: "<title> is checked back in. Thanks, friend!" }`. 404 "That game isn't on loan to you." when asked to return one they don't have.
  - **Borrow:**
    - no plan: 403 "Join the library to borrow games, friend.";
    - held for them: the hold is collected and the loan made;
    - otherwise the plan needs room (the plan message above) and a copy must be free: 409 "Every copy of <title> is reserved or out on loan. Ask us at the counter.";
    - → `{ result: 'borrowed', loan, hold (the hold it collected, or null), library, message: "<title> is yours to take home. Scan it again when you bring it back." }`.
  - 401 "Log in to borrow games." `library` is their GET /me `library`, fresh.
  - ★ The app can't tell where the phone is, so a borrow scanned outside the Lair works too. Staff see every loan and can mark any back on the shelf.
- **`POST /library/loans/:id/return`** (the member it's with, or staff): the member gets `{ loan, library }`, staff get `{ loan: staffLoan }`. 404 "That loan could not be found.", 403 "That game isn't on loan to you." One already returned comes back as it is.
- **GET /me adds `library`:**
  ```
  library: {
    plan: { name, games } | null,
    used,                      // active holds + games at home
    holds: [ hold ],           // active, soonest until first
    atHome: [ loan ]           // out, longest at home first
  }
  ```
  Round 6's top-level `holds` (active, plus those that ended in the last 3 days) stays as it is.

### Staff routes
- **`POST /library/loans { customerId, code }`** (or `variantId` with `title`, `shelfCode`, `handle` for a game typed in): check a game out to a member at the counter → `{ loan, notice }`.
  - Their hold on that game, if any, is collected. No plan or copies check (what's in the staff member's hands goes out): `notice` says "That's more than Sam's plan (3 games at a time)." or "Shopify thinks every copy is out. Check the copies on the product.", else null.
  - 404 "No member with that customer ID." Code errors as above.
- **`POST /library/return { code }`**: check a game in by scanning it.
  - One copy of it out: it's returned → `{ result: 'returned', loan }`.
  - Several out: nothing changes → `{ result: 'pick', loans: [staffLoan] }`, and staff pick one (the route below).
  - None out: 404 "That game isn't out on loan. It must be on the shelf already."
- **`POST /library/loans/:id/return`**: "Back on the shelf" for any loan.
- **`GET /library/loans?status=out|all`** → `{ loans: [staffLoan] }`: `out` (the default) longest at home first, `all` the last 200, newest first.
- **`GET /library/holds`** adds each hold's `image`, and `loanId` on a collected one. `POST /library/holds/:id/update { status: 'collected' }` answers `{ hold, loan }`.

### Views
```
hold:      round 6's hold view + image (null when unknown)
loan:      { id, variantId, productId, title, shelfCode, handle, image, status: 'out' | 'returned', outAt, returnedAt, holdId }
staffLoan: loan + { customerId, name, email, code (member code), days (whole days at home, or that were), staffNote }
```
`image` is a Shopify CDN address (the theme adds `width=`), or null. With null, the theme uses `/products/<handle>.js`'s featured image.

### Emails
- The hold emails keep their words, with the new `until` wording: staff "Hold this game: Catan (DGL34-001) for Sam, until midnight on Friday 9 October"; the member "Catan is on hold for you until midnight on Friday 9 October. Collect it at the counter with your member code."
- Their "See it in My Lair" button opens `/pages/my-lair?view=library`.
- No emails for loans.

### Postal swaps
The cutoff is Wednesday 10pm for Thursday delivery. That's theme copy only (shell); the Lair app has no postal rules.

### Stored
`library_loans`, `library_games`, `library_codes`, `library_holds.image`, and the loans made for collected holds (migration 17).

### Demo (library)
Loans, scan, check-out, check-in and GET /me's `library` on the demo's library copies (the mock's fixed ids, with shelf codes like DGL34-001). A code that isn't one of them answers the 404, a shop product's barcode the 422. `holdUntil` follows the midnight rule.

---

## 7. Tab: scan an item [A] (theme: library)

> "Also the camera is not there for scanning items to add to your tab."

- **`GET /tab/lookup?code=`** (logged in): a scanned barcode or SKU → something the tab can take.
  ```
  { item: { variantId, productId, handle, title, variantTitle ('' for "Default Title"), price (cents), image, available, barcode, sku } }
  ```
  - Shopify: `LairVariantByCode` (section 13), exact match on barcode first, then SKU (ignoring case).
  - ★ **What a tab takes:** an `ACTIVE` product. "Published" means Active here: café things sold only at the counter count. Not a library copy, a gift card, or something that needs a selling plan.
  - Stock isn't refused here: `available` is Shopify's `availableForSale`, and the theme keeps today's "<name> is sold out, sorry friend. Pick something else from the menu."
  - Answers are kept 10 minutes.
- **Errors:**
  - 401 "Log in to start a tab."
  - 422 "Scan a barcode, or type the code under it." (empty, or not letters, numbers and `. _ - +`)
  - 404 "Gobgob doesn't know that one. Pick it from the menu instead." (the theme's words today)
  - 422 "That's one of our library games. Borrow it in My Library, friend. It doesn't go on a tab."
  - 422 "That one isn't on sale right now. Ask us at the counter, friend." (draft or archived)
  - 422 "That one can't go on a tab. Ask us at the counter, friend." (gift card, selling plan)
  - 429 "Easy, friend. Give the scanner a minute." (60 lookups a member in 10 minutes)
  - 503 "Gobgob can't look up barcodes just now. Pick it from the menu instead." (read_products not approved yet, or Shopify down; back off 10 minutes)
- **The tab itself doesn't change:** the theme adds the item to "this round" and `POST /tab` saves it.
- **The theme's order** (library, in my-lair.js's scanning block):
  1. the Tab menu catalogue (barcode or SKU, no network);
  2. a product link in a QR code (`/products/<handle>`);
  3. `GET /tab/lookup`;
  4. on its 503 or a network error, the store's predictive search, as today;
  5. "Gobgob doesn't know that one…".
- **Demo (library):** `tabLookup` finds the catalogue's barcodes and SKUs, plus a few demo codes (one of them a library copy for the 422), and answers 503 when the page has `?tablookup=down`, so the fallback can be tried.

---

## 8. Finding a customer (the picker) [B] (theme: staff-admin, staff-games)

Groups, pass owners, GMs and players all pick customers the same way.

- **`GET /customers?q=`** (staff; `q` 2 to 80 characters):
  ```
  { customers: [ { customerId, name, firstName, email, code, member } ], shopify }
  ```
  - First, Lair members matching like `GET /members?q=` (name, email, member code, customer ID), up to 10.
  - Then Shopify customers not already listed (`LairCustomers`, the default search over name and email, newest first), up to 20 in all. `member: false` marks someone the Lair hasn't met (no `code`).
  - `q` goes to Shopify only as letters, numbers, spaces and `@ . _ - + '`, quoted.
  - `shopify: false` when Shopify couldn't be asked (protected customer data not approved, or down; back off 10 minutes). The theme then says "Only people who've used the Lair show up right now. Not there? Type their name and email."
- 422 "Type at least 2 letters to search." Staff only (403 as other staff routes).
- **Picking someone with `member: false`:** every route below that takes a `customerId` also takes that person's `name` and `email` from the picker. The Lair makes their member record with them (a member code, and no welcome roll, section 3). A `customerId` the Lair doesn't know, sent with no name: 404 "That customer could not be found. Pick them from the search again."
- **Demo (staff-admin):** `findCustomers` searches the demo members plus three demo customers who aren't members yet. staff-games calls `be.findCustomers ? be.findCustomers(q) : be.findMembers(q)`, so it works before the merge.

---

## 9. Groups and session passes [B] (theme: staff-admin; mylair shows group passes in the Wallet)

> "For issuing a session pass let it choose groups not individuals thanks. It should automatically add their name and email. Have the option to choose individual and not a group as well."

### Rules
- **A group** has a name (2 to 60 characters, unique among active groups, ignoring case), an organiser (a customer, always one of its members), members (customers only, up to 200), a staff note (up to 300 characters), and is `'active'` or `'archived'`. Someone can be in several groups.
- **A session pass belongs to exactly one of:** a group (`groupId`), one customer (`customerId`, picked with section 8: their name and email fill in from the account), or a name typed by hand (`holderName`, with `holderEmail` optional, as today, for someone with no account).
- **A group's pass:**
  - any active member of the group can use it: `usePass` when they book, at check-in, and at the POS;
  - it shows in each member's Wallet, with the group's name;
  - its code comes from the group's name (Warhammer League: WL-…);
  - its holder reads as the group: `holder: { customerId: null, name: <group name>, email: '' }`.
- **Archiving a group** stops its members using its passes (they leave their Wallets). Staff can still type the code at the counter, or move the pass. Removing someone from a group does the same for them.
- **A group's pass can't be claimed or redeemed:** 409 "That pass belongs to a group. Ask us at the counter."

### Staff routes
- **`GET /groups?q=&status=active|archived|all`** → `{ groups: [group] }`. `active` is the default; `q` matches the group's name and its members' names, emails and codes. Up to 100, by name.
- **`POST /groups { name, organiser?: person, members?: [person], note? }`** → `{ group }`.
- **`POST /groups/:id/update { name?, organiser?: person, note?, status? }`** → `{ group }`.
- **`POST /groups/:id/members { add?: [person], remove?: [customerId] }`** → `{ group }`.

`person` is `{ customerId, name?, email? }` from the picker. An organiser who isn't a member yet is added.

```
group: {
  id, name, organiser: { customerId, name, email, code } | null,
  members: [ { customerId, name, email, code } ], note, status: 'active' | 'archived',
  passes: [ { id, code, label, sessionsLeft, sessionsTotal, status } ], createdAt, updatedAt
}
```

Messages:
- 422 "Give the group a name (up to 60 characters)."
- 409 "There's already a group called <name>."
- 404 "That group could not be found."
- 422 "A group can have up to 200 people."
- 409 "That's the organiser. Pick a new organiser first." (removing them)
- 422 "A group is active or archived."
- section 8's 404 for an unknown customer.

### Passes
- **`POST /passes`** takes `groupId`. It needs exactly one owner:
  - 422 "Pick a group, pick a customer, or type a name."
  - 422 "A pass belongs to a group or a person, not both."
  - 404 "That group could not be found."
  - 409 "That group is archived. Pick another, or bring it back first."
  - A `customerId` of someone who isn't a member yet comes with `holderName` and `holderEmail` from the picker (section 8). Today that's a 404 "That member could not be found." That 404 now only happens with no name.
- **`POST /passes/:id/update`** takes `groupId` (a group, or null to take it off the group; then it needs a customer or a holder's name).
- **Every pass view** (staff `passView`, the member's) adds `group: { id, name } | null`. `GET /passes?q=` also matches group names.
- **GET /me `passes`:** their own passes, plus the passes of their active groups (active, or used up in the last 30 days), each with `group`.
- **`usePass`** on `POST /bookings` and `POST /events/:id/reserve`: a member may use a pass of an active group they're in.
- **Check-in** (`POST /checkin` with a member code) and the **POS member answers** (`/pos/scan`, `/pos/member`): `passes` include their active groups' passes, with `group`. Using a pass at check-in by its code works for any pass, as today. Changing the POS extension's screen is optional; if backend-b changes `pos-app/`, its tests must pass.

### Theme
- **staff-admin:** a Groups tab; the pass form's owner choice (Group, Customer, Type a name); group names on passes. With a customer picked, the name and email fill in and can't be edited.
- **mylair:** the Wallet shows a group's pass with "<group name> group" under its label.

### Demo (staff-admin)
`state.groups`; group passes in the demo's `createPass`/`updatePass`, and in `passesFor()` for the Wallet.

---

## 10. Events editor [B] (theme: staff-admin; the calendar is shell's)

> "I want an event section for staff view so that we can edit and add and change events if necessary with all the relevant details."

### Rules
- **Events are the `lair_event` metaobjects.** The Lair writes them through the Admin API (write_metaobjects, write_files) and reads them with read_metaobjects. Nothing is copied into the Lair. Quick table holds (`POST /blocks`) stay where they are, under Holds and openings.
- **The fields, as the definition has them** (checked through the Admin API on 6 Oct: 19 fields; `title` and `starts_at` required; no publishable status, so every entry is live):

| API key | Field | Type | Rule |
|---|---|---|---|
| `title` | `title` | single line | Required, 1 to 80 characters |
| `type` | `event_type` | choice | Required: `tcg`, `rpg`, `wargame`, `market`, `social`, `tournament`, `learn`, `launch` or `other` |
| `game` | `game` | single line | Optional, up to 40 characters (the definition's max) |
| `start` | `starts_at` | date_time | Required, ms. Written in Lair time with its offset, like the existing entries: `2026-10-08T18:00:00+13:00` |
| `end` | `ends_at` | date_time | Optional, after `start`, at most 24 hours after it. Left out, the apps take 3 hours, as now |
| `repeat` | `repeat` | choice | `''` (one-off), `weekly`, `fortnightly` or `monthly` |
| `repeatUntil` | `repeat_until` | date | Optional `'YYYY-MM-DD'`, repeating events only, on or after the first date |
| `skipDates` | `skip_dates` | list.date | Optional list of `'YYYY-MM-DD'`, repeating events only, each on or after the first date, at most 52, kept sorted and without repeats |
| `description` | `description` | multi line | Optional, up to 2000 characters |
| `imageId` | `image` | file_reference (Image) | Optional MediaImage id from `POST /events/pictures` (or the one it has) |
| `capacity` | `capacity` | integer, min 1 | Optional, 1 to 500 |
| `priceNote` | `price_note` | single line | Optional, up to 60 characters ("Free entry", "$10 entry") |
| `entryFee` | `entry_fee` | decimal, min 0, 2 places | Optional, **dollars** in (0 to 1000), cents out |
| `payment` | `payment` | choice | `'store'` → "In store", `'online'` → "Online", `'either'` → "Online or in store" |
| `tables` | `tables` | single line | Optional; must read as tables that exist (`parseTableList`): "T20-T21", a room's name, or "all" |
| `gameTables` | `game_tables` | single line | Optional; spots like "T14+T15, T16+T17" whose tables exist (`parseSpots`) |
| `lockTables` | `lock_tables` | boolean | `true` or `false` |
| `link` | `link` | url | Optional, `https://` or `http://`, up to 300 characters |
| `productId` | `product` | product_reference | Optional ticket product: a number or `gid://shopify/Product/…` |

  - In a create or an update, `null` or `''` clears an optional field: the Lair sends Shopify `value: ""` for it. Values are written as Shopify expects: dates `YYYY-MM-DD`, `list.date` as a JSON list, booleans `"true"`/`"false"`, numbers as text, references as gids.
- **Handles** come from the title: lower case, letters, numbers and dashes, up to 50 characters, with `-2`, `-3`… when taken (`LairEventHandle`). They never change, since sign-ups and game spots are kept by `<handle>@<date>`. `joins` and `pictures` are never handles (they're routes).
- **A date with sign-ups can't move or go.** Before an update or a delete, the Lair works out the event's upcoming dates (now to 400 days ahead) before and after the change. If a date that has sign-ups (not cancelled) or game spots (active bookings with that `occurrence_id`) would disappear, or start or end at a different time: 409, and nothing changes.
  - Update: "People have signed up for Thu 8 Oct, so that date can't move or go. Cancel their sign-ups on the staff page first, or make the change from a date nobody's signed up for."
  - Delete: "People have signed up for Thu 8 Oct. Cancel their sign-ups first, or end the event after that date with Repeat until."
  - (A sign-up landing between the check and Shopify's answer is the one case staff sort by hand.)
- **Lower capacity is fine.** Nobody is cancelled; `notice` says "Thu 8 Oct already has 8 people, more than the new capacity. Nobody's been cancelled."
- **After every write the Lair drops its cached events** (`rulesCache`), so sign-ups, game spots and table holds follow at once.
- **What the storefront sees:** Liquid reads the metaobjects directly (`snippets/lair-config.liquid`), so the calendar, the booking map and the home page show the change on their next load. Shopify's page cache can take a minute or two. The staff page doesn't wait: it puts the saved event's `config` into `store.cfg.events` (replacing the one with the same `id`, or adding it; taking it out after a delete) and calls `store.refresh()`, so its floor and holds update at once.

### Routes (staff)
- **`GET /events`** → `{ events: [event] }`: every entry, those with dates to come first (soonest `next` first), then the rest (latest `last` first).
- **`POST /events { …fields }`** → `{ event, notice }`.
- **`POST /events/:handle/update { …the fields that change }`** → `{ event, notice }`.
- **`POST /events/:handle/delete`** → `{ ok: true, handle }`. The picture stays in Shopify's Files.
- **`POST /events/pictures { dataUrl, alt? }`** → `{ image: { id, url, alt, status } }`.
  - The browser shrinks the picture first (up to 1600 px wide; JPEG, PNG or WebP; at most 700 KB, the game pictures' limit).
  - The Lair then:
    1. asks `LairStagedUpload` for a target (`resource: IMAGE`, `httpMethod: POST`, a filename like `lair-event-<random>.jpg`, the MIME type, `fileSize`);
    2. posts the file to it itself: a multipart form with every parameter Shopify gave, in order, then `file`. The Worker sends it, not the browser, so there's no cross-site question;
    3. calls `LairFileCreate` (`originalSource`: the target's `resourceUrl`, `contentType: IMAGE`, `alt`).
  - `id` is the MediaImage id to save as `imageId`. `url` can be null while Shopify is still processing it: the staff page keeps showing its own preview.
  - If saving the event then says the file isn't ready, wait a second and try once more.

```
event: {
  id (the metaobject's gid), handle, title, type, game, start, end, repeat, repeatUntil, skipDates, description,
  image: { id, url, alt } | null, capacity, priceNote, entryFee (cents | null), payment: 'store' | 'online' | 'either',
  tables, gameTables, lockTables, link, product: { id, handle, title } | null,
  repeatTag (section 17's wording, null for a one-off), next (ms of the next date, or null), last (ms of the last date to come, or null),
  booked: [ { occurrenceId, start, people (sign-ups), spots (game spots) } ],   // upcoming dates with anyone on them
  updatedAt,
  config: { … }   // the event exactly as lair-config.liquid writes it, for store.cfg.events
}
```
- `config` keys: `id` (the handle), `title`, `type`, `game`, `start` and `end` (the stored strings), `repeat`, `repeatUntil`, `skipDates`, `capacity`, `tables`, `entryFee` (cents), `gameTables`, `payment`, `lockTables`, `price`, `url` (the product's page, else `link`), `link`, `product` (null, or `{ url, title, price: null, available: null, stock: null }`), `blurb`, `image` (the picture at `width=800`, or null) and `imageAlt`.
- **Reading:** `LairEventsAdmin` asks for the image and product references. If Shopify answers ACCESS_DENIED (read_products or read_files not approved yet), it asks again without them (`LairEventsAdminPlain`): the image and product come back as ids only.

### Messages
422 for each field that breaks its rule:
- "Give the event a title."
- "Pick what kind of event it is."
- "Pick when it starts."
- "It has to finish after it starts."
- "Keep an event to 24 hours or less. Use Repeats for more dates."
- "Pick how often it repeats: weekly, fortnightly or monthly. Or leave it as a one-off."
- "'Repeat until' has to be on or after the first date."
- "Skip dates have to be real dates, on or after the first date."
- "Capacity is a number of people, from 1 to 500."
- "Keep the price note short: 60 characters at most."
- "The entry fee is in dollars, from $0 to $1000."
- "Pick how people pay: in store, online, or either."
- "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all."
- "Game tables are pairs like T14+T15, T16+T17, with tables that exist."
- "Links start with https://."
- "The game's name is 40 characters at most."

Other answers:
- Shopify userErrors: 422 "Shopify said no: <its message>".
- 404 "That event could not be found."
- Pictures: 422 "Pick a JPEG, PNG or WebP picture." / 413 "That picture is too big. Try a smaller one." / 502 "Shopify didn't take the picture (<reason>). Try again."
- write_metaobjects or write_files not approved yet (ACCESS_DENIED): 503 "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again."

### Demo (staff-admin)
`listEvents`, `createEvent`, `updateEvent`, `deleteEvent` and `uploadEventPicture` work on the page's `cfg.events` plus an overlay kept in `state.eventEdits` (made, changed and deleted entries). The same checks and messages. The date rule uses the demo's sign-ups. A picture's `url` is the browser's own preview (a data URL), and `config` is built the same way.

---

## 11. Staff making TTRPG sessions [B] (theme: staff-games)

> "Let the table choosing for the gms inside the staff picking be the same process with seeing what is available and you would take it or not the table etc. Don't do another way."
> "For find a GM for the staff booking, if the gm is not a customer let us write an email and they will be prompted to create an account."

### Rules
- **One form.** Staff make sessions with the GMs' own "Run a game" form (`<lair-session-form>`, section 18): the same fields, checked the same way (`checkGameDetails`). So staff sessions land in the same categories and sub-filters (system, tags, level, age) as anyone's.
- **One table map, one availability rule.** A table is free when no active booking, staff hold or **locked** event table overlaps the time. Soft event tables are free, with their label. Today `POST /games` from staff skips the house rules (`checkGameSession(…, { staff: true })`); from round 7 it doesn't. Opening hours, whole hours, the lead time and horizon, players fitting the tables, the table count, locked event tables and rooms not bookable online apply to staff exactly as to GMs.
- ★ **The two staff differences kept, and why:**
  1. **Shop tables** (T1 to T3) are open to staff-made sessions and to staff adding a date. They're the team's own tables, and staff making a session there is the same as opening them (the base contract's openings).
  2. **Editing an existing session** (`POST /games/:id/edit`) skips only the lead time and the booking horizon, so tonight's session can still move to another table. Locked event tables, bookings and holds block a move for staff too (today staff skip locked event tables).
- **Series dates** (weekly and fortnightly top-ups, `planSessions`) of a staff-made series follow the same rule as their first session (GM rules plus shop tables), instead of today's `details.staffCreated` bypass.
- **Approval:** staff-made sessions are open at once, as today.

### The GM: picked, or invited by email
**`POST /games`** (staff) takes the form's fields plus one of:
- **`gmCustomerId`**, picked with section 8. Send `gmCustomerName` and `gmEmail` from the picker when they aren't a Lair member yet. The session is theirs at once and they get "Your game is live: <title>" (round 5's "listed for you" email), as today.
- **`gmEmail`**, with the board name in `gm`, for a GM who isn't a customer.
  - If the email is a Lair member's, they're linked, as today.
  - If not, the session is made with that email and no account, and the GM gets the invite (section 15). The answer adds `invited: true` and `notice`: "Gobgob emailed <email> to make an account. The game joins their account when they log in with that email."
  - (It replaces round 5's "No member has that email yet, so this game isn't linked to their account…".)
- Neither: the staff member is the GM themselves, as today (that's staff using the games board's own form). The staff page's form always sends one of the two, and says "Pick the GM from the customers, or type their name and email." before sending when neither is filled in.

### Linking an invited GM
On GET /me (My Lair, and the games board's own GET /me), round 6's guest adoption (`adoptGuestBookings`, with the member's verified Shopify account email) also links games:
- sessions with no GM account whose `gm_email` is that email (ignoring case), upcoming or ended in the last 30 days, become theirs (`gm_customer_id`);
- so do their series and the GM's table holds (`kind: 'gm'` bookings).

Until then the GM's store credit is "add it in Shopify admin" (`status: 'manual'`), as for any unlinked GM today.

### What staff and the GM see
- **Floor games for staff** add `gmEmail` and `gmAccount: 'linked' | 'invited' | 'none'`. The staff page shows "Invited: waiting for <email> to make an account" for `'invited'`.
- **An invited GM** gets the invite email, then a "New player for …" email at that address whenever someone joins (round 6).
- **Once they log in with that email,** the sessions are in My Lair (Games I run) and on the games board with everything a GM has: players, messages, adding dates, cancelling, and store credit straight onto their account after each session.

### Demo (staff-games)
The demo's `createGameForGm` applies the GM form's checks and availability (shop tables allowed for staff) and the invite (an email in the demo outbox, `gmAccount: 'invited'`). A demo login with that email links it.

---

## 12. Seats: regulars, players staff add, reserved seats [B] (theme: staff-games)

> "There should be seats reserved for ttrpg sessions, and once someone gives up their seat that seat is open otherwise it will be open for anyone."

### Regulars' seats (today's behaviour, confirmed: no change)
- A weekly regular's seat is booked in the series' next session, and held in every later one: `regularsWaiting` and `heldIn` keep it out of everyone else's reach.
- It stays theirs until they give it up:
  - skipping one session (cancelling that seat) frees just that seat, for anyone;
  - leaving the series (`POST /series/:id/leave`) cancels their upcoming seats and stops the holds.
- A freed seat is open to anyone.

### Staff adding players
**`POST /games/:id/players`** (staff) takes:
```
{ customerId?, customerName?, name, email?, phone?, people (1 to 8), players?, weekly?: true }
```
- **A customer** (`customerId` from the picker, or an email that's a Lair member's): the seat is theirs (linked) and they get the seat confirmation, as today. With `weekly: true` on a session of a series, they also become a regular from this session on: a series member, queued from now, exactly as if they'd tapped "Save my seat every week". Their later seats are saved, and maintenance books each next session. They get "You're a regular!" (section 15) as well.
- **Someone without an account, by name** (and email): a reserved seat in this session (no account; the confirmation email says "Make an account with this email any time, and your seats will show up in My Lair."). With `weekly: true`:
  - their email is required: 422 "Add their email, so Gobgob can invite them to keep the seat.";
  - they're also invited to be a regular, and the confirmation's last line becomes "It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week.";
  - when they log in with that verified email (GET /me, the same adoption as section 11), the invite becomes their regular membership, queued from when they were invited. If the series has ended, the invite is cancelled.
  - ★ An invite doesn't hold seats in later sessions until it's taken up: only regulars hold seats.
- `weekly: true` on a one-off: 422 "This game is a one-off, so a seat can't be saved every week."
- Seats and the seats held for regulars are checked as today.
- **Answer:** round 3's `{ booking, game, emailed }`, plus `regular: { seriesId, customerId } | null` and `invite: { id, email } | null`.
- `phone` is optional here (staff-made, section 1).

### Stopping
**`POST /series/:seriesId/leave`** takes, from staff, `{ customerId }` (stop a regular: the same as them leaving, with the GM's email) or `{ inviteId }` (cancel an invite; their reserved seat stays until staff remove it). Messages:
- 404 "They're not a regular at that game."
- 404 "That invite could not be found."

Members leave as today.

### Views
Floor games for staff and for the session's GM add `invites: [ { id, name, email, people } ]` (waiting invites of its series). Players' `member` and `regular` flags come from section 2.

### Demo (staff-games)
`addGamePlayer` with `weekly` (`state.seriesMembers` for customers, `state.seriesInvites` for invites), the demo's `stopRegular` for the leave route, and invites taken up on a demo login with that email.

---

## 13. Shopify Admin API operations

All on API 2026-07 through `ShopifyAdmin.graphql`. Each was checked with the Shopify MCP's `validate_graphql_codeblocks` on 6 Oct 2026, and passed. The reads were also run read-only against the store: `LairVariantByCode` found DGL56-002 and DGL7+-001 with their `library_code` and featured image, and `lair_event`'s definition and entries were read for section 10. **The operation name is the fake Admin API's switch key** (`tools/qa/live/fake-admin.mjs`), so use these names exactly.

| Operation | Owner | What | Scopes | Validated |
|---|---|---|---|---|
| `LairVariantByCode($query)` | A | `productVariants(first: 5, query: $query) { nodes { id title sku barcode price availableForSale media(first: 1) { nodes { preview { image { url } } } } product { id handle title status isGiftCard requiresSellingPlan featuredMedia { preview { image { url } } } libraryCode: metafield(namespace: "custom", key: "library_code") { value } } } }`, `$query` = `barcode:"<code>" OR sku:"<code>"`. Library scans and tab lookups | read_products (waiting for Mo) | ✓ (ProductVariant.image is deprecated, so `media`) |
| `OrderSpend($id)` (existing) | A | adds `discountCodes` and `processedAt` to `order(id:)` | read_orders | ✓ |
| `LairGiftCodeUse($code)` | A | `codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic { status endsAt asyncUsageCount } } }` | read_discounts (in write_discounts) | ✓ |
| `LairCustomers($query)` | B | `customers(first: 10, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { id displayName firstName lastName verifiedEmail defaultEmailAddress { emailAddress } } }` | read_customers, plus protected customer data (Name, Email) | ✓ |
| `LairEventsAdmin($after)` | B | `metaobjects(type: "lair_event", first: 100, after: $after, sortKey: "updated_at", reverse: true) { nodes { id handle updatedAt fields { key type value reference { __typename ... on MediaImage { id alt image { url width height } } ... on Product { id handle title } } } } pageInfo { hasNextPage endCursor } }` | read_metaobjects; the references need read_files and read_products | ✓ |
| `LairEventsAdminPlain($after)` | B | the same without `reference` (fallback) | read_metaobjects | ✓ |
| `LairEventHandle($handle)` | B | `metaobjectByHandle(handle: $handle) { id handle updatedAt fields { key type value } }`, `$handle: { type: "lair_event", handle }` (is a handle taken; one event) | read_metaobjects | ✓ |
| `LairEventCreate($metaobject)` | B | `metaobjectCreate(metaobject: $metaobject) { metaobject { id handle updatedAt fields { key type value } } userErrors { field message code } }`, with `{ type: "lair_event", handle, fields: [{ key, value }] }` | write_metaobjects (waiting for Mo) | ✓ |
| `LairEventUpdate($id, $metaobject)` | B | `metaobjectUpdate(id: $id, metaobject: $metaobject) { …same… }`, `{ fields: [{ key, value }] }` (only what changes; `value: ""` clears) | write_metaobjects | ✓ |
| `LairEventDelete($id)` | B | `metaobjectDelete(id: $id) { deletedId userErrors { field message code } }` | write_metaobjects | ✓ |
| `LairStagedUpload($input)` | B | `stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }`, `[{ resource: IMAGE, filename, mimeType, httpMethod: POST, fileSize }]` (`fileSize` as a string) | write_files (waiting for Mo) | ✓ |
| `LairFileCreate($files)` | B | `fileCreate(files: $files) { files { id fileStatus alt ... on MediaImage { image { url width height } } } userErrors { field message code } }`, `[{ originalSource: resourceUrl, contentType: IMAGE, alt }]` | write_files | ✓ |

Notes:
- The app's scopes (`pos-app/shopify.app.toml`) already ask for read_products, read_inventory, write_metaobjects and write_files. Mo approves them once in Shopify admin. Until then, those features answer the 503s above and everything else works.
- `FEATURE_SCOPES` lists them on the status page while they're missing. Only backend-b edits that line, replacing it with exactly:
  ```js
  const FEATURE_SCOPES = { write_discounts: 'birthday gift product codes', read_products: 'library copies, scanning library games and tab items', read_inventory: 'library copies on the shelf', write_metaobjects: 'staff adding and editing events', write_files: 'event pictures' };
  ```
- `value: ""` clearing a metaobject field is how the Admin API is used for optional fields (MetaobjectFieldInput.value is non-null). The coordinator confirms it on the store with the first real edit.
- Protected customer data: `LairCustomers` needs the Name and Email fields, the same approval round 5 asked for. Without it the picker falls back to Lair members (section 8).

---

## 14. What's stored

Each backend agent appends **one** entry to `MIGRATIONS` in `src/lair.js`, at the end. backend-a's is entry 17 and backend-b's entry 18: in backend-b's branch it sits at 17 until the merge. This is the one expected merge conflict, and the coordinator keeps both, backend-a's first. Nothing may depend on an entry's number. Only new tables, new columns (nullable or with defaults) and `IF NOT EXISTS` indexes, plus the two one-off `INSERT … SELECT`s into backend-a's own new tables below.

### Migration 17 (backend-a)
```sql
ALTER TABLE members ADD COLUMN mobile TEXT
ALTER TABLE members ADD COLUMN pronouns TEXT
ALTER TABLE members ADD COLUMN favourite_games TEXT
ALTER TABLE members ADD COLUMN about TEXT
ALTER TABLE members ADD COLUMN profile_updated_at INTEGER
ALTER TABLE event_joins ADD COLUMN phone TEXT
CREATE TABLE IF NOT EXISTS roll_codes (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, rolls INTEGER NOT NULL, total_limit INTEGER, expires_at INTEGER, status TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)
CREATE TABLE IF NOT EXISTS roll_code_uses (
  id TEXT PRIMARY KEY, code_id TEXT NOT NULL, customer_id TEXT NOT NULL, rolls INTEGER NOT NULL, grant_id TEXT, at INTEGER NOT NULL,
  UNIQUE (code_id, customer_id))
CREATE INDEX IF NOT EXISTS roll_code_uses_code ON roll_code_uses (code_id, at)
ALTER TABLE gifts ADD COLUMN product_used_at INTEGER
ALTER TABLE gifts ADD COLUMN product_order TEXT
ALTER TABLE gifts ADD COLUMN product_checked_at INTEGER
ALTER TABLE library_holds ADD COLUMN image TEXT
CREATE TABLE IF NOT EXISTS library_loans (
  id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, product_id TEXT, title TEXT NOT NULL, shelf_code TEXT, handle TEXT, image TEXT,
  customer_id TEXT NOT NULL, hold_id TEXT, status TEXT NOT NULL, out_at INTEGER NOT NULL, returned_at INTEGER, out_by TEXT,
  returned_by TEXT, staff_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)
CREATE INDEX IF NOT EXISTS library_loans_variant ON library_loans (variant_id, status)
CREATE INDEX IF NOT EXISTS library_loans_customer ON library_loans (customer_id, status)
CREATE UNIQUE INDEX IF NOT EXISTS library_loans_hold ON library_loans (hold_id) WHERE hold_id IS NOT NULL
CREATE TABLE IF NOT EXISTS library_games (
  variant_id TEXT PRIMARY KEY, product_id TEXT, title TEXT NOT NULL, handle TEXT, shelf_code TEXT, image TEXT, checked_at INTEGER NOT NULL)
CREATE TABLE IF NOT EXISTS library_codes (key TEXT PRIMARY KEY, variant_id TEXT NOT NULL)
-- the games handed over in round 6 are at home until staff say otherwise
INSERT OR IGNORE INTO library_loans (id, variant_id, product_id, title, shelf_code, handle, image, customer_id, hold_id, status, out_at,
  returned_at, out_by, returned_by, staff_note, created_at, updated_at)
  SELECT 'ln_' || id, variant_id, product_id, title, shelf_code, handle, NULL, customer_id, id, 'out',
    COALESCE(ended_at, updated_at, created_at), NULL, 'staff', NULL, NULL, COALESCE(ended_at, updated_at, created_at), COALESCE(ended_at, updated_at, created_at)
  FROM library_holds WHERE status = 'collected'
-- the games round 6's holds already named
INSERT OR IGNORE INTO library_games (variant_id, product_id, title, handle, shelf_code, image, checked_at)
  SELECT variant_id, MAX(product_id), MAX(title), MAX(handle), MAX(shelf_code), NULL, MAX(created_at) FROM library_holds GROUP BY variant_id
```
- `library_codes` is filled in code (`codeKey` of each shelf code), not in SQL. On round 7's first start, `migrate()` also fills it from `library_games` once (guarded by a meta key), and writes the meta key `gift-codes-from`. Roll codes use the existing `codes` table with kind `'roll'`.

### Migration 18 (backend-b)
```sql
CREATE TABLE IF NOT EXISTS lair_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, organiser_id TEXT, note TEXT, status TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER)
CREATE TABLE IF NOT EXISTS lair_group_members (
  group_id TEXT NOT NULL, customer_id TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (group_id, customer_id))
CREATE INDEX IF NOT EXISTS lair_group_members_customer ON lair_group_members (customer_id)
ALTER TABLE passes ADD COLUMN group_id TEXT
CREATE INDEX IF NOT EXISTS passes_group ON passes (group_id)
CREATE TABLE IF NOT EXISTS series_invites (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, people INTEGER NOT NULL, players TEXT,
  status TEXT NOT NULL, customer_id TEXT, booking_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)
CREATE INDEX IF NOT EXISTS series_invites_email ON series_invites (lower(email), status)
CREATE INDEX IF NOT EXISTS games_gm_email ON games (lower(gm_email))
```
- The group tables are `lair_groups` and `lair_group_members` because `GROUPS` is an SQLite keyword.
- An invite's `status` is `'waiting'`, `'joined'` or `'cancelled'`.
- A GM invite needs no table: a session with `gm_email` and no `gm_customer_id` is one.

### The tests
- New tests go in new files: `test/round7-a.test.js` (backend-a) and `test/round7-b.test.js` (backend-b). Copy the few helpers you need (`fakeCtx`, `call`, `at`) from `test/lair.test.js`.
- Edit `test/lair.test.js` only where an existing test changes on purpose (the welcome roll, hold times, the optional phone, staff game rules), inside those tests.
- Both agents replace the round 6 migration test's two lines (5308 and 5309 at 44b5175) with exactly these, byte for byte, so the merge is clean:
  ```js
    assert.ok(MIGRATIONS.length >= MAIN_MIGRATIONS.length + 2, 'round 6 adds one migration (later rounds add theirs after it)');
    assert.ok(MIGRATIONS[MAIN_MIGRATIONS.length + 1].every((s) => /^\s*(ALTER TABLE \w+ ADD COLUMN|CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS)/.test(s)), 'only new columns, tables and indexes');
  ```
- Run them under `TZ=UTC` and `TZ=Pacific/Auckland`: holds that cross a daylight saving change, and gift dates.

---

## 15. Emails

Every email uses the existing template (`letter`, `renderEmail`) in Gobgob's voice. Only these are new or change.

| Email | Owner | Subject | What it says |
|---|---|---|---|
| Hold this game (staff) | A | "Hold this game: <title> (<shelf>) for <name>, until midnight on Friday 9 October" | As round 6, with the new `until` wording |
| On hold for you (member) | A | "<title> is on hold for you" | As round 6, "…until midnight on Friday 9 October…"; button to `/pages/my-lair?view=library` |
| Session gift codes (buyer) | A | "Your session gift is ready" | As round 6; the redeem line says "under 'Got a code?'" |
| GM invite | B | "You're running <title> at the Dice Goblin Lair" | See below |
| You're a regular (staff added them) | B | "You're a regular: <title>" | Round 5's "You're a regular!" email, but the intro is "Kia ora <name>, the Dice Goblin team has saved your seat at <title> with GM <gm> every week." ("fortnight" or "session" to match the schedule) |
| Seat confirmation for a reserved weekly seat | B | As round 6's seat confirmation | Its last line is "It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week." instead of the general "Make an account…" line |

**The GM invite:**
- Title "Your game is on the board!".
- Intro: "Kia ora <gm>, the Dice Goblin team has put <title> on the games board for you."
- Details as round 5's "Your game is live": Game; When, or First session; Tables; Player seats; Your credit.
- Then: "Make your Dice Goblin account with this email (<email>): log in at dicegoblin.nz with it, and the game joins your account. Then you can see who's coming, message your players and add dates in My Lair, and your store credit goes straight onto your account after each session." and "Players can book already. Gobgob will email you each time someone joins."
- Button "Open My Lair". Signed "Happy GMing!" / "Gobgob".

No email for roll codes, groups, loans, profile changes or the events editor.

---

## 16. Backend merge rules (backend-a and backend-b work on the same files)

Touch only what you must, and put new code at these places, so the two branches merge without conflicts.

- **`src/lair.js`, the router in `fetch()`:**
  - backend-a adds:
    - `GET /members/:customerId` and `GET /roll-codes` right after the `members … spend` GET line;
    - `GET /library/loans` and `GET /tab/lookup` right after the `library … holds` GET line;
    - `POST /me/codes/redeem` right after the `me/passes/claim` line;
    - the roll-codes POSTs right after the `members … since` line;
    - the library POSTs right after the `library/holds/:id/update` line.
  - backend-b adds:
    - `GET /groups`, `GET /customers` and `GET /events` right after the `passes` GET line;
    - the groups POSTs right after the `passes/:id/apply` line;
    - the events POSTs right after the `events/:id/reserve` line (`POST /events` with no id, `/events/pictures`, `/events/:handle/update`, `/events/:handle/delete`).
  - **Only backend-b edits the `known` list** (the status note), adding both agents' new names: GET `'tab'`, `'roll-codes'`, `'groups'`, `'customers'`, `'events'`; POST `'roll-codes'`, `'groups'`.
- **Functions.**
  - Only backend-a edits: `me()`, `saveProfile`, `touchMember`, `welcomeRoll` callers, `loyaltyOf`, `memberView`, `members`, `birthdayList`, the gift functions, the hold and library functions, the tab functions, `createBooking`, `joinEvent`, `reserveSpot`, `joinSeries`, `seatSeriesMember`, `gamePlayers`, `staffJoinView`, `ordersPaid`, `posScan`.
  - Only backend-b edits: the pass functions (`passFields`, `createPass`, `updatePass`, `listPasses`, `passView`, `memberPassView`, `memberPasses`, `activePasses`, `passForBooking`, `claimPass`), `createGame`, `editGame`, `addSession`, `planSessions`, `addPlayers`, `leaveSeries`, `floor()`, `adoptGuestBookings`.
  - backend-a's redeem calls `claimPass` as it is; backend-b adds the group check inside `claimPass`.
  - backend-a leaves `me()`'s two lines `if (account.fetched) …` and `if (account.email) this.adoptGuestBookings(…)` as they are: backend-b extends what `adoptGuestBookings` does (GM invites, series invites), and the calls to `memberPasses` and `gamePlayers` stay as they are too.
- **`src/core.js`:**
  - backend-a: `holdUntil` and the hold constants, plus the mobile check (`checkMobile`, `mobileKey`), next to `libraryPlan`.
  - backend-b: the staff options of `checkTableBooking` and `checkGameSession` (a shop-tables-only allowance, and skipping only the lead time and horizon on edits).
- **`src/shopify.js`:** backend-a adds its methods right after `variantCopies()`; backend-b adds its methods right after `appInfo()`. backend-a changes the `OrderSpend` query.
- **`src/lair.js` constants:** `FEATURE_SCOPES` and new constants. backend-b adds its scopes there; both add new constants next to related ones (backend-a after `ADOPT_DAYS`, backend-b after `STATUS_IDS`).
- **`tools/qa/live/fake-admin.mjs`:** backend-a adds its cases right after the `VariantCopies` case (and `discountCodes` on the fake `OrderSpend`); backend-b adds its cases right after the `LairData` case.
- **README.md:**
  - Each agent documents its own routes next to related rows of the route table: backend-a after the `members/birthdays` row and after the `library/holds` rows; backend-b after the `passes?q=` row and after the `events/joins/:id/cancel` row.
  - In Notes: backend-a edits the maintenance note (gift checks) and adds a "Round 7 (members, codes, gifts, library loans) added…" note after the "Round 6 added…" note; backend-b adds its "Round 7 (groups, events, staff sessions) added…" note after the `LAIR-PASS-<n>` note.
  - Day to day bullets go next to their related bullets.
- **Concurrency rule, as always:** all awaits first (Shopify lookups, uploads), then one synchronous read-check-write. Shopify writes in the events editor happen after the local sign-up check (section 10 says what that leaves).

---

## 17. Theme-only rules everyone shares

- **Recurring events in the calendar** (shell):
  - A repeating `lair_event` reads as one thing with a repeat tag and its next date, never a wall of copies.
  - Day and week views still put it on its day, with the tag. Lists, "what's on" and the home page collapse each series to one entry (its next date, which links to that date).
  - The tag: "Weekly · Thursdays 6pm", "Fortnightly · Thursdays 6pm", "Monthly · Third Saturday 11am" (first, second, third, fourth, fifth).
  - Times as Mo says them: "6pm", "6:30pm". The next date: "Next: Thu 8 Oct".
  - The staff events list shows the same tag (backend-b's `repeatTag` is worked out the same way).
  - TTRPG sessions already show only a series' next session (round 5).
- **Out-of-stock products are hidden** (shell): not rendered in collections, search, recommendations and rails, and not counted in "N products" where Liquid can avoid it. The Availability filter goes. Library copies (any product with `custom.library_code`) are never hidden by this rule.
- **Shopify's `t` filter escapes HTML** in translations (keys not ending `_html`), so `{{ 'x' | t | json }}` hands JS `We&#39;re`. The rule for every words block JS reads:
  - Liquid stays `{{ 'key' | t | json }}`.
  - JS decodes the five entities once, where it reads the block, then treats the words as plain text (escape them again only when putting them in `innerHTML`).
  - shell adds `decodeText` to lair-core.js's small helpers and exports it on `window.Lair`. Anyone may use `(window.Lair && window.Lair.decodeText) || decode` with this exact local copy until the merge:
    ```js
    const decode = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]);
    ```
  - Each agent fixes it in the files it owns this round (section 18); shell fixes it everywhere else. The library page Mo photographed is the library agent's.
- **Hold times** (library): section 6's wording, everywhere a hold's `until` shows: the library page, My Library, the staff page, and the old Home row until mylair takes it out.
- **Postal swaps** (shell): "Wednesday 10pm for Thursday delivery", wherever the library and membership pages say the cutoff (it was 10am Thursday).
- **Mobile fields** (shell): section 1.
- **Logos** (shell, mylair): MO.md decision 2. Sized, compressed theme assets, never the originals.

---

## 18. Theme modules this round

Five theme agents work at once. Each owns files, or clearly marked parts of shared files. Rule: don't edit what another agent owns. If you truly need a one-line change there, make it, keep it tiny, and list it in your report.

### 18.1 Who owns which file

| File | Owner | Others may |
|---|---|---|
| layout, header, announcement bar, home, collections, search, product grids, `assets/lair-booking.js`, `assets/lair-join.js`, `assets/lair-calendar.js`, `sections/events-calendar.liquid`, `sections/lair-map.liquid` | shell | — |
| `snippets/lair-config.liquid` | shell | keep every event key section 10's `config` lists, with the same meaning |
| `assets/lair-core.js` | shared | each agent adds `LiveBackend` methods only at its anchor (18.5). shell adds `decodeText` (small helpers, and the `window.Lair = {` export) |
| `assets/lair-demo.js` | shared | each agent edits only its own demo methods and adds new ones at its anchor (18.5); demo state keys in 18.6 |
| `assets/lair-scan.js` | library | everyone calls it (18.2); library may add, never change, its API |
| `sections/my-lair.liquid`, `assets/my-lair.js`, `assets/lair-my.css` | mylair | library owns my-lair.js's scanning block (18.3) and adds two tag lines (18.3) |
| `assets/lair-my-library.js`, `assets/lair-my-library.css` (new) | library | — |
| `assets/lair-library.js`, `snippets/library-reserve.liquid` | library | — |
| `assets/lair-games.js`, `assets/lair-games.css`, `sections/gm-games.liquid` | staff-games | — |
| `assets/lair-session-form.js` (new) | staff-games | — |
| `assets/lair-staff.js` | shared, by region (18.4) | — |
| `sections/lair-staff.liquid` | shared, by line (18.4) | — |
| `assets/lair-staff-events.js`, `assets/lair-staff-groups.js`, `assets/lair-staff-codes.js`, `assets/lair-staff-admin.css` (new) | staff-admin | — |
| `assets/lair-staff-library.js` (new, if library wants one) | library | — |
| `assets/lair-staff.css` | shared | add CSS next to the block of your own feature, never at the end |
| `locales/en.default.json` | shared | add keys inside your own namespace's block: `lair.my.*` mylair, `products.library.*` library, `lair.staff.*` staff-admin and staff-games (each next to its own keys), the rest shell |

### 18.2 The camera scanner (assets/lair-scan.js, library owns it)
It already offers everything the others need. Use only this:
- **Open:** `const close = window.LairScan.open({ formats, onCode, title, hint, inputLabel, inputMode, submitLabel, onClose })`. It shows the full-screen sheet: back camera, Close, and "Type a barcode instead".
- **Get a code:** `onCode(code, { format, typed })` runs once per code, with reading paused while it works.
  - Return or resolve to `{ message, tone: 'ok' | 'error', close, closeAfter }` to show a line (and close after `closeAfter` ms);
  - `true` to close now;
  - anything else to keep scanning.
- **Close:** call `close()`, or answer `{ close: true }`.
- **Formats:** `LairScan.formats` (EAN-13, EAN-8, UPC-A, UPC-E, Code 128, QR). Library labels are QR or Code 128, the tab's things EAN or UPC, tickets and member cards QR.
- One sheet at a time: opening a new one closes an open one (library makes sure).

Who uses it: My Library (borrow and return), the tab scanner (my-lair.js's scanning block), the staff page's check-in camera (as now) and the staff Library tab (check out, check in). Nobody adds a second camera component.

### 18.3 My Lair (mylair owns it; library plugs in)
- **Sections** (`[data-view]` names): `home`, `bookings`, `wallet`, `library`, `tab`, `profile`. A top row of labelled links (`[data-view-link]`) shows them all. Addresses: `#home` (or none), `#bookings`, `#wallet`, `#library`, `#tab`, `#profile`, and `?view=<name>` (emails use it).
  - Old addresses keep working: `#me` → profile; `#ml-library` → library; `#ml-orders`, `#ml-passes`, `#ml-gifts`, `#ml-credit`, `#ml-dice` → wallet; `#ml-birthday` → profile; `#ml-tab` → tab; `#ml-tables`, `#ml-seats`, `#ml-events`, `#ml-games` → bookings; `#ml-card` → home.
- **Home:** a summary card for every area, with its key numbers from GET /me, that opens it:
  - Bookings: upcoming count;
  - Wallet: store credit from Liquid, sessions left on passes, rolls ready, gifts ready;
  - Library: `library.used` of `library.plan.games`, held and at home;
  - Tab: today's total and `dueNow`;
  - Profile: what's missing, like "Add your mobile".
- **Wallet:** store credit, passes (group passes with their group's name), **"Got a code?"** (`redeemCode`), rolls and their history, birthday gifts (section 5's states) and orders.
- **Profile:** the player profile (section 2), the GM profile as an optional box under it, then staff tools and log out.
- **The Library view's container** (mylair writes it, inside `data-view="library"`):
  ```html
  <my-library data-plans-url="{{ library_url }}#plans" data-shelves-url="{{ library_shelves }}">
    <p class="ml-loading">…a holding line until the component draws…</p>
  </my-library>
  ```
- **What `<my-library>` gets** (an agreement between the two):
  - `<my-lair>` keeps the last GET /me answer on itself as the property `me`.
  - After every successful GET /me, `<my-lair>` dispatches `lair:me` (bubbles) with `detail: { me }`.
  - `<my-library>` reads `me.library` (and `me.holds` for holds that ended), from the property when it connects and from each event.
  - After it changes anything (borrow, return, cancel a hold), it dispatches `lair:refresh` (bubbles), and `<my-lair>` fetches GET /me again.
- **Tags** (library adds exactly these two lines to my-lair.liquid; mylair doesn't change the lines around them):
  - `{{ 'lair-my-library.css' | asset_url | stylesheet_tag }}` right after the `lair-my.css` stylesheet line;
  - `<script src="{{ 'lair-my-library.js' | asset_url }}" defer></script>` right after the `my-lair.js` script line.
- **The tab scanner:** library owns my-lair.js's scanning block, from the comment `/* scanning: the camera sheet` to just before `/* ---------- the loyalty card` (`openScanner`, `scanned`, `keep`, `flash`, `findCode`, `fetchProduct`, `searchCode` at 5fdeb84). It adds section 7's lookup there. mylair keeps the Tab view's `[data-scan]` button visible (Mo couldn't find the camera) and keeps `[data-tab-catalogue]`, `[data-tab-menu]` and the "this round" bar as they are.
- **Until the merge,** the library agent tests `<my-library>` by putting it on the My Lair page in its flow check (Playwright `document.createElement`), not by editing the views.
- **The old "Library games they've reserved" row on Home goes** (mylair); My Library shows holds now.

### 18.4 Staff page
- **Tabs** (staff-admin replaces the `TABS` line of lair-staff.js with exactly this; nobody else edits it):
  ```js
  const TABS = [['floor', 'Floor'], ['today', 'Today’s bookings'], ['passes', 'Passes'], ['groups', 'Groups'], ['members', 'Members'], ['codes', 'Codes'], ['holds', 'Holds and openings'], ['games', 'GM games'], ['events', 'Events'], ['library', 'Library']];
  ```
- **Panels** (staff-admin, in `build()`, right after the passes panel's `</section>`): one `<section class="staff-panel" id="panel-<id>" role="tabpanel" aria-labelledby="tab-<id>" data-panel="<id>" hidden>` each for `groups`, `codes` and `events`, holding `<staff-groups>`, `<staff-codes>` and `<staff-events>`.
- **Opening a tab** (staff-admin adds one line at the end of `setTab()`, before `this.render()`): `this.dispatchEvent(new CustomEvent('lair-staff:tab', { bubbles: true, detail: { id } }))`. The new elements load their data the first time their tab opens, and again after a minute away. Deep links `#events` and `?tab=codes` work through `TABS`.
- **Regions of lair-staff.js** (comment headers at 5fdeb84). Add click handlers next to your feature's existing handlers in the events region, never at the end of the switch.
  - **staff-admin:** check-in at the counter (group passes in the member card), birthdays coming up, session passes (the owner choice), members (gift words, profile, `memberDetail`), the loyalty card and spend, waiving, birthday gifts (rolls default 0), and the three new tabs (their own files).
  - **staff-games:** GM games, member search, GM game actions, a game's picture. "Make a session" and "Edit" use `<lair-session-form data-for="staff">`.
  - **library:** the library region (holds, "Back on the shelf", check out and in with the scanner, games at home).
- **Tags in sections/lair-staff.liquid** (each a single line insert, at a place nobody else touches):
  - library: `lair-staff-library.js` (if it makes one) right after the `lair-core.js` script line;
  - staff-games: `lair-session-form.js` right after the `lair-scan.js` script line;
  - staff-admin: `lair-staff-events.js`, `lair-staff-groups.js` and `lair-staff-codes.js` right after the `lair-staff.js` script line, and `lair-staff-admin.css` right after the `lair-staff.css` stylesheet line.
- **The session form** (`assets/lair-session-form.js`, staff-games): it defines `<lair-session-form>` and moves the "Run a game" steps and `GmFloor` (`<gm-floor>`, the table map) out of lair-games.js.
  - `data-for="gm"`: the games board's "Run a game", as now.
  - `data-for="staff"`: the same steps and map, shop tables shown as free for staff (section 11), and the last step is "Who's running it?" (pick a customer, or a name and email to invite) plus the GM fee.
  - `data-game-id="…"` edits a session.
  - It submits with `store.mutate('createGame' | 'createGameForGm' | 'editGame', …)` and dispatches `lair:session-saved` (bubbles) with `detail: { result }`.
  - After a staff create, the staff page offers "Add players" (`addGamePlayer`: customers, saved every week or not, or a seat reserved under a name and email).
  - lair-games.js loads it: staff-games adds the tag in sections/gm-games.liquid after the `lair-join.js` line.

### 18.5 LiveBackend and demo anchors
Each agent adds its new methods **right after** the named existing method, in `LiveBackend` (lair-core.js) and in `DemoBackend` (lair-demo.js), one short method per route (`this.request(…)` in LiveBackend). Edit existing methods only where your section changes them.

| Agent | After this method | New methods |
|---|---|---|
| mylair | `claimPass` | `redeemCode(code)` → POST /me/codes/redeem |
| library | `updateLibraryHold` | `libraryScan(code, action)` → POST /library/scan; `libraryLoans(status)` → GET /library/loans; `checkOutLibraryGame(input)` → POST /library/loans; `returnLibraryGame(code)` → POST /library/return; `returnLibraryLoan(id)` → POST /library/loans/:id/return |
| library | `clearTab` | `tabLookup(code)` → GET /tab/lookup |
| staff-admin | `memberSpend` | `memberDetail(customerId)` → GET /members/:customerId; `rollCodes(status)`, `createRollCode(input)`, `updateRollCode(id, input)` |
| staff-admin | `undoPassUse` | `findCustomers(q)` → GET /customers; `listGroups({ q, status })`, `createGroup(input)`, `updateGroup(id, input)`, `groupMembers(id, input)` |
| staff-admin | `contact` | `listEvents()`, `createEvent(input)`, `updateEvent(handle, input)`, `deleteEvent(handle)`, `uploadEventPicture(dataUrl, alt)` |
| staff-games | `createGameForGm` | `stopRegular(seriesId, input)` → POST /series/:id/leave with `{ customerId }` or `{ inviteId }` |
| shell | none | (`createBooking`, `joinGame`, `joinSeries`, `joinEvent` and `reserveEvent` already pass `phone` through) |

Demo methods also changed in place:
- mylair: `me()` (`profile` right after the `member:` line; the gifts and loyalty fields), `saveProfile`, the loyalty seed.
- library: `me()` (`library: this.libraryFor(c),` right after the `holds:` line), `holdUntil`, the library methods.
- staff-admin: `createPass`, `updatePass`, `passesFor`, the members and birthdays methods.
- staff-games: `createGame`, `createGameForGm`, `editGame`, `addGameSession`, `addGamePlayer`.
- shell: `createBooking`, `joinGame`, `joinSeries`, `joinEvent`, `reserveEvent` (the mobile check).

### 18.6 Demo state keys (each owned by one agent)

| Key | Owner | Shape |
|---|---|---|
| `members[].mobile`, `pronouns`, `favouriteGames`, `about` | mylair (shell writes `mobile` too) | on the existing demo member objects |
| loyalty `codes` | mylair | added to the demo loyalty object |
| `rollCodes` | staff-admin (mylair's `redeemCode` adds uses) | `[{ id, code, rolls, limit, expiresAt, status, note, createdAt, uses: [{ customerId, at }] }]`; seed in section 3 |
| `groups` | staff-admin | `[{ id, name, organiser, members: [customerId], note, status, createdAt }]`; passes gain `groupId` |
| `eventEdits` | staff-admin | `{ [handle]: { deleted?, fields } }` over `cfg.events` |
| `customers` | staff-admin | the three demo customers who aren't members |
| `libraryLoans`, `libraryGames` | library | loans and the demo's scannable library copies |
| `seriesInvites` | staff-games | `[{ id, seriesId, name, email, people, players, status }]` |
| `gmInvites` | staff-games | not needed if a demo game keeps `gmEmail` with no `gmCustomerId` |

---

## 19. Decisions this contract made (★), and what goes back to Mo

For the coordinator to check before the builders start:
1. **Welcome rolls already given stay** (section 3). Only preview users have them, and taking rolls back would be a clawback.
2. **Generated roll codes look like GG-KOBOLD-14**, and typed codes are 4 to 24 letters, numbers or dashes (section 3).
3. **Loans have no due date**, so there's no "overdue" list; staff see days at home (section 6). Mo set no limit.
4. **A member can borrow by scanning anywhere**: the app can't tell they're in the Lair. Staff see and fix loans (section 6).
5. **A tab takes any Active product** (not library copies, gift cards or selling-plan products). "Published" is read as Active, so counter-only café items work; sold-out ones are still refused by the theme, as today (section 7).
6. **Staff-made sessions keep two differences:** shop tables are open to them, and edits skip the lead time and horizon. Everything else is the GM rule, including locked event tables (section 11).
7. **A reserved weekly seat's invite doesn't hold later seats** until the person makes an account (section 12).
8. **Event pictures go up through the Lair** (staged upload sent by the Worker, then fileCreate), not straight from the browser, to avoid any cross-site question on Shopify's upload target (section 10).
9. **A date with sign-ups can't move or go** in the events editor: 409 (section 10).
10. **Gifts made before round 7 are checked once** for use through the discount's usage count, dated when checked (section 5).

For Mo (the coordinator asks him, in plain words):
- Approve the app's waiting permissions in Shopify admin: read_products, read_inventory, write_metaobjects, write_files. Until then: no barcode lookups for the library and tab (known games and the menu still work), and no saving in the events editor.
- Make the welcome code on the staff page once it's live (say WELCOME, 1 roll), or let the coordinator make it.
- Protected customer data (Name, Email): if it isn't approved yet, the customer search only finds people who've used the Lair.
- Points 3, 4 and 6 above, if he'd rather have due dates, scan-in-the-Lair-only, or no shop tables for staff sessions.

## 20. What the coordinator does
- Merges (backend-a's migration before backend-b's), live harness, deploy, theme upload, and Mo's scope approvals.
- Store data: the WELCOME code if Mo wants it, the Session gift on sale with the stacked logo (MO.md 17), Library below Events in the menu.
- **Agents must not** write to the store, push, upload theme files or call the live Worker.

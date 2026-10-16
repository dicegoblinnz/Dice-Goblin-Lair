# Lair API contract v16-library-lending: staff lend games to anyone

16 Oct 2026. **Changes only**, on top of v7 (section 6, the library), v16-library-returns and everything since; where
they disagree, this file wins. Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

Mo (16 Oct): "I want to give the staff the ability to lend out a game to anyone even if they don't have an account it
still adds to their account but no charge as they will not be subscribed but it is still evident that they have the
game. This helps us lend out stuff to people without pressuring them to be subscribers. But reserved only for staff."

## 1. Rules

- **Only staff lend**, from the staff page's Library tab (the Library permission). Members still borrow with a library
  plan, as before: a member with no plan who scans a game in My Library is still told to join (403).
- **Lent to someone with an account but no library plan:** staff pick them as before (`{ customerId }`). The game is
  **lent**: no plan needed and nothing to pay. Before today they got the game with a notice ("Ari isn't on a library
  plan."); now there's no notice.
- **Lent to someone without an account:** staff type their **name** and an **email or mobile** (at least one, so we can
  reach them about the game). The game goes out under that name.
  - An email the Lair knows (a member's email, or their Shopify account's, ignoring case) lends it to **that member**,
    exactly as if staff had picked them.
  - Otherwise it waits under the email, and **joins their account when they log in to My Lair** with a verified Shopify
    account on that email (the same moment their guest bookings join it). Games already back on the shelf come too, as
    their history. With only a mobile it stays under their name: staff see it, and it never joins an account.
- **Lent games never use up a plan.** They're at home with the person (My Library, the staff page, the game's page counts
  the copy out) but they don't count towards a plan's games: not now, and not if they join the library later. A game
  they borrow on a plan (scan, hold, staff check-out) counts as before.
- **A member with a plan** checked out at the counter: one of their plan's games, as before, with the same notices (plan
  full, payment didn't go through, Shopify thinks every copy is out). Never lent.
- **Coming back:** a lent game comes back like any other, only through staff: scanned at the counter
  (`POST /library/return`) or "Back on the shelf" (`POST /library/loans/:id/return`). A member who scans a lent game at
  home with them gets v16-library-returns' `at-home` answer.
- **Nothing is charged** for a lent game, and no email goes out. When a library membership ends, its emails (and the
  staff note about games still out) ask only for the plan's games back, not lent ones (`gamesAtHome`).

## 2. Data

`library_loans` gets four columns, made when the Lair starts (added when missing; nothing to run by hand):

| Column | |
| --- | --- |
| `lent` | `INTEGER NOT NULL DEFAULT 0`: 1 for a game staff lent outside a plan |
| `guest_name` | who it was lent to, when the Lair didn't know them |
| `guest_email` | their email, lower case (or null) |
| `guest_mobile` | their mobile, as `checkMobile` tidies it (or null) |

A guest's loan has `customer_id` `''` until it joins an account; then it's that member's (the guest columns stay, as a
record of what staff typed). Index `library_loans_guest` on `guest_email` where `customer_id = ''`. Every loan before
today is `lent = 0`.

## 3. Routes

### 3.1 `POST /library/loans` (staff, Library)

The game, as before: `{ code }` (scanned or typed), or `{ variantId, title, shelfCode, handle }`. Who it goes to:

- `{ customerId }`: someone the Lair knows (404 "No member with that customer ID." otherwise), as before.
- **New:** `{ guest: { name, email?, mobile? } }` when there's no `customerId`.

Checked in this order, before the game is looked up and before anything is lent:
- 403: not staff ("Staff only. Log in with your staff account."), or staff without the Library permission (v9-team).
- No `customerId` and no `guest` object: 422 `who`.
- `guest.name` missing or blank: 422 `name`. It's trimmed (spaces inside squashed), up to 80 characters.
- `guest.email` given but not an email: 422 `email`.
- `guest.mobile` given but not a mobile: 422 with the mobile words every booking uses (`MOBILE_WRONG`: "That mobile
  number doesn't look right. Try one like 021 123 4567.").
- Neither an email nor a mobile: 422 `reach`.

Then the game's 422, 404 and 503 (v7), then the loan. Returns **200** `{ loan, lent, notice }`:

- `loan`: the staff loan view (3.3).
- `lent`: true when it went out as a lent game (no plan, or no account), false when it's one of a plan's games.
- `notice`: null, or the counter's notices (plan full, payment, copies). A lent game only ever gets the copies one.

### 3.2 `GET /me` (logged in)

- Loans waiting under their verified account email join their account first (with their guest bookings).
- `library.atHome[]` has `lent` (below). `library.used` counts holds and the games at home that **aren't** lent.
- A member with no plan and lent games has `library.plan: null`, `used: 0` and the games in `atHome`.

### 3.3 Loan views

- **The member's** (`library.atHome[]`, `POST /library/scan`'s `loan`): adds `lent` (boolean).
- **Staff's** (`POST /library/loans`, `GET /library/loans`, `POST /library/return`, `POST /library/loans/:id/return`,
  a member's detail on the Members tab): adds `lent`, `guest` and `mobile`:
  - `guest`: true for a game lent to someone without an account the Lair knows. Then `customerId` is **null**, `code`
    null, and `name`, `email` (or `''`) and `mobile` (or `''`) are what staff typed.
  - Once it joins their account, it's like any member's: `guest` false, their `customerId`, name, email and member code,
    and `mobile` `''`.

### 3.4 Unchanged

`POST /library/scan` (members borrow with a plan; 403 "Join the library to borrow games." without one), holds,
`POST /library/return`, `POST /library/loans/:id/return`, `GET /library/status` (a lent game is out like any other).

## 4. Words (word for word)

| Key | Words |
| --- | --- |
| `who` | Pick the member, or add the name of who you're lending it to. |
| `name` | Add the name of who you're lending it to. |
| `email` | That email doesn't look right. Try one like name@example.com. |
| `reach` | Add their email or mobile, so we can reach them about the game. |

Exported from `src/lair.js` as `LENDING_WORDS`. The notice "{name} isn't on a library plan." is gone.

## 5. The theme (website team)

- **Staff page, Library tab, check-out:** besides picking a member, staff can lend to someone new: name, email, mobile
  (`lair-core.js`'s `checkOutLibraryGame` posts `{ guest: { name, email, mobile }, code }`). Say when it went out as a
  lent game ("Lent to Wiremu: nothing to pay"), and when the email belonged to a member (the loan's `name` and `guest`
  false).
- **Games at home:** mark lent games ("Lent"), and for a guest show the email or mobile instead of a member code (there's
  no member to open).
- **My Library:** lent games are at home with them, with no pressure to join. Someone with no plan and lent games sees
  the games (with how to return them) before anything about joining; a member with a plan sees lent games marked as not
  using up their plan.
- **The demo backend** (`assets/lair-demo.js`) does the same, so the round 7 library check runs in demo mode.

## 6. Checks

`test/round16-lending.test.js`: staff only, the words, a guest's loan (out, counted on the game's page, adopted at login,
scanned back, "Back on the shelf", history), a mobile-only guest, an email the Lair knows, a member with no plan (lent,
no notice) who joins later (lent games don't use the plan, and a membership ending doesn't ask for them back), and a
plan member's check-out (not lent).

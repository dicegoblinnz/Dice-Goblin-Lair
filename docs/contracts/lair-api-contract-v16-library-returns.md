# Lair API contract v16-library-returns: staff put games back on the shelf

16 Oct 2026. **Changes only**, on top of v7 (section 6, the library) and everything since; where they disagree, this
file wins. Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx. Backend branch `library/staff-returns`.

Mo (16 Oct): "have the check out of the library game be made by the staff not the public as I just realized they can
just scan it out even if it was at home. So user can only scan games to add to their library but needs staff to scan
games to put back on the shelf."

## 1. Rules

- **Members only borrow.** Scanning a game in My Library adds it to their library (borrows it), as before: their hold on
  it is collected, or a free copy goes out if their plan has room.
- **Only staff put a game back on the shelf:** scanning it at the counter (`POST /library/return`) or "Back on the shelf"
  on the staff page (`POST /library/loans/:id/return`), both with the Library permission. Until then it's at home with
  the member, whatever they scan. A game posted back is checked in by staff when it arrives.
- Why: the app can't tell where a phone is (v7, section 6), so a member could "return" a game that was still at home.
- Nothing changes in the database: loans are `'out'` or `'returned'` as before, and loans members returned before today
  stay returned.

## 2. Routes

### 2.1 `POST /library/scan { code, action? }` (logged in)

In this order:
- 401 "Log in to borrow games."; the code's 422, 404 and 503 (v7) as before.
- **At home with them already**, whatever `action` says (`'return'`, `'borrow'` or none): nothing changes, and it's never
  borrowed a second time (a double tap included: one scan borrows, the other finds it at home) → **200**
  `{ result: 'at-home', loan, library, message }`:
  - `loan`: their loan of it, as v7's loan view, still `status: 'out'`;
  - `library`: their GET /me `library`, fresh (the game is still in `atHome`, `used` is unchanged);
  - `message`: `alreadyHome` (section 3).

  It's checked before the plan, so a member with no plan, or whose plan is paused (v10's 402), still gets `at-home` for
  a game at home with them.
- `action: 'return'` for a game that **isn't** at home with them: 404 "That game isn't on loan to you." (as before).
- Anything else is a **borrow**, as before (403 with no plan, v10's 402, the plan's and the copies' 409s) →
  `{ result: 'borrowed', loan, hold, library, message }`, with `borrowed`'s new words (section 3).

`result: 'returned'` never comes back from this route any more.

### 2.2 `POST /library/loans/:id/return` (staff, Library)

- Staff with the Library permission: as before, "Back on the shelf" → `{ loan: staffLoan }`; one already returned comes
  back as it is; 404 "That loan could not be found."
- **Anyone else: 403** with `staffOnly` (section 3), and nothing changes. That's a member (the one it's with too), a
  helper without the Library permission (a member here, as everywhere else in v9-team) and someone not logged in (a 401
  before). The permission is checked before the loan is looked up, so members never get the 404.
- The member's old answer (`{ loan, library }`) has gone.

### 2.3 Unchanged

`POST /library/return { code }` (staff: check a game in by scanning; one out `{ result: 'returned', loan }`, several
`{ result: 'pick', loans }`), `POST /library/loans` (staff: check a game out), `GET /library/loans`, holds,
`GET /library/status` (`atHome` still says it's at home with them) and GET /me's `library`.

## 3. Words (word for word)

`{title}` is the game's title without " (Library)".

| Key | Words |
| --- | --- |
| `alreadyHome` | {title} is already in your library. To return it, bring it to the counter and staff will scan it back onto the shelf. |
| `borrowed` | {title} is yours to take home. When you're done, bring it to the counter and we'll scan it back onto the shelf. |
| `staffOnly` | Staff check games back in at the counter. Bring it in and we'll scan it back onto the shelf. |

`borrowed` was "{title} is yours to take home. Scan it again when you bring it back." The return words ("{title} is
checked back in. Thanks, friend!") are gone.

## 4. The theme (website team)

- **My Library's scanner** (`assets/lair-my-library.js`, `scanned()`): `result: 'at-home'` is an answer, not an error.
  Say its `message` in the sheet and again on the page, as after a borrow; the game stays under At home. The words it
  falls back on when `message` is missing: `borrowed` for a borrow and `alreadyHome` for at-home; the "checked back in"
  fallback goes.
- **My Library's hint** under Scan a game ("Borrow one off the shelf in the Lair, or scan it again when you bring it
  back."): scanning is for borrowing now. Suggested: "Scan a game off the shelf in the Lair to borrow it. To return one,
  bring it to the counter and we'll scan it back onto the shelf."
- **The game page's at-home text** (`products.library.reserve.home_text` in `locales/en.default.json`: "You borrowed it
  [when]. When it's back in the Lair, scan it in My Library to return it, or hand it in at the counter."). Suggested:
  "You borrowed it [when]. To return it, bring it to the counter and we'll scan it back onto the shelf." The comment at
  the top of `assets/lair-library.js` says the same as the old text.
- **No return button for members.** `returnLibraryLoan` (`lair-core.js`) is staff only now; My Library doesn't call it
  today, so keep it that way. The staff page's Library tab is unchanged. `lair-core.js`'s comment on `libraryScan`
  ("borrow or return") goes out of date.
- **The demo backend** (`assets/lair-demo.js`): `libraryScan` answers `at-home` for a game at home with them (never
  ending the loan, never a second one), a 404 for `action: 'return'` otherwise, and the new `borrowed` words;
  `returnLibraryLoan` is a 403 with `staffOnly` for anyone but staff with Library. The round 7 library check in the Lair
  repo (`tools/qa/round7/library.mjs`) runs demo mode and expects this.

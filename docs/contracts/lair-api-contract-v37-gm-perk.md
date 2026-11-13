# Lair API contract v37-gm-perk: the GM perk, the staff slot and a game's books

14 Nov 2026. **Changes only**, on top of v7 (section 6, the library), v16-library-lending, v16-library-returns,
v21-gm-credit, v30-library and everything since; where they disagree, this file wins. Errors stay
`{ error: "A plain sentence." }` with a 4xx or 5xx.

Mo (14 Nov 2026, 5:05am): "I want a special tag that staff [can] give to certain customers who are gms, and given to the
customers that sign up to run roleplaying games. As a perk they get the option to get one library copy of any RPG
books, only one copy per person. And it is free as a perk of being a gm. Only issue is that when gms set up [to] run
games they should ask for a copy of the game to be soft reserved for [their] game as reference for their game when they
play, this does not stop someone from taking a game but will be notified that there are games that want this game on
such and such date. And it is implied that it would be good for them to bring the book back on that date nothing forced
but we might send a nudge if a week or two passed and the book is not back. This will help gms run [their] games and
give them a chance to explore more games etc. give any customer access to it when they sign up to a game and start
running one. But after 3 games consecutively that have not been filled it will disable the perk. Staff can give
permission directly and take it away as well. The three weeks no game remove perk function still applies to staff
giving to customers the tag etc. Also give all staff the perk of adding any library game from dice goblin as a perk not
just RPG books. One slot only."

His three answers the same morning (each the option this chat recommended):

- A session is **filled** with **at least 1 player** on it (how the Lair already counts a session as run: v21-gm-credit).
- The perk switches off on **both**: 3 unfilled sessions in a row, **or** 3 weeks with no session run and none coming up.
- A new GM gets it **when their game is listed** (on the board), not after their first session.

Why: the Lair is short of GMs (Mo, 2 Nov 2026), and the books that help someone run or try a system sit behind a
library plan. On 14 Nov 2026 the board had 7 weekly public games (4 D&D 5e, 2 Mutants & Masterminds, 1 Zi'Dara) and the
RPG shelf 174 listings, nearly all one copy each, the Player's Handbook included. So who wants a book back, and when,
matters as much as the free loan.

## 1. Rules

### 1.1 Two perks, one slot each

- **The GM perk:** one book from the library's **RPG shelf** at home at a time, free. An RPG-shelf book is a library
  game whose shelf code starts `DGLRPG`, or that the catalogue has tagged Shelf RPG books (the tag's handle,
  `shelf-rpg-books`, as the theme and v30-library read tags).
- **The staff slot:** everyone on the team (the main account, tagged staff in Shopify, and the helpers on the Team tab)
  has one library game at home at a time, from **any** shelf, free.
- **One slot a person.** Someone on the team who also runs games has the staff slot only. A perk game already at home
  fills the slot, whichever perk it went out on.
- **On top of a library plan.** A perk game never counts towards Grab, Stash or Hoard, needs no plan, and nothing is
  charged for it: it's a lent game (v16-library-lending, `lent` 1) that also says which perk it went out on (`perk`).
- **Never a game that stays in the Lair** (tagged In Store Only, v30-library): refused as for anyone.
- The perk lives in the Lair, not in a Shopify tag: helpers have no Shopify admin, and it switches itself on and off.

### 1.2 Who has the GM perk

It's a record per customer (`gm_perks`): **on**, or **off** with a reason.

- **On by itself, the first time:** someone with no record who is the GM (`gm_customer_id`) of a session **on the
  board** (status `open`, not ended). So: a game listed by a trusted GM or by staff for them, a game staff approve, and
  a game staff listed by email that joins their account. Games already on the board when this goes live count: the
  10-minute run switches those GMs on. Reason `listed`.
- **On when staff give it** (1.8). Reason `staff`. It rests like any other.
- **It rests by itself** (off, reason `quiet` or `idle`), a perk staff gave too:
  - `quiet`: the last **3** sessions of theirs that count (1.3), since the perk last went on, were all quiet.
  - `idle`: **21 days** since the perk last went on, no session of theirs played in the last 21 days, and none coming
    up (a session of theirs, `open` or waiting for approval, that hasn't ended).
- **Back by itself after a rest:** as soon as a session of theirs that started after the rest began has been
  **played** (1.3). Reason `played`. Listing a game doesn't bring it back; a game with players does.
- **Off when staff take it** (1.8). Reason `staff`. It never comes back by itself: only staff giving it does. Staff can
  take it from someone who never had it, so it never switches itself on for them.
- Each time it goes on, `since` is that moment, and only sessions starting after it count towards the next rest.
- Someone on the team gets no GM perk record from listing a game (they have the staff slot). One they had before
  joining the team stays as it is underneath, and counts again if they leave.

### 1.3 Which sessions count

A session counts once its **end** has passed, for whoever is its GM then.

- **Played:** on the board (`open`) with **at least one player**: a player's seat (a `gm-seat` booking that's
  `confirmed`, `seated` or `done`, not the GM's own), or players the group has who don't book through the Lair
  (`offline_players`). The same test as a GM's stamp (v21-gm-credit).
- **Quiet:** on the board with no player; or **cancelled within 24 hours of its start, or after it** (the group didn't
  show, nobody had booked).
- **Doesn't count either way:** a session cancelled more than 24 hours before its start (plans changed), and one that
  was never approved.

### 1.4 Borrowing with a perk

Wherever a game goes out to a member: their own scan in My Library (`POST /library/scan`) and the staff desk
(`POST /library/loans` with `customerId`, or a guest's email the Lair knows).

In this order, for a game that isn't at home with them already and doesn't stay in the Lair:

1. **A hold of theirs on it** is collected, as before (holds are a plan's, by the plan's rules: with the plan's
   payment behind, the scan says so, and the perk doesn't take a game they've reserved; once they cancel the hold, it
   does).
2. **Their perk covers it and the slot's free:** it goes out on the perk, plan or no plan. A copy must be free for a
   scan (409, the words as before); the desk hands over what's in staff's hands, with the copies notice as before.
3. **Otherwise their plan**, exactly as before. With no plan, the scan's refusal says why the perk didn't help
   (section 4): the slot's in use (409), the GM perk covers the RPG shelf only (403), the perk's having a rest (403);
   anyone else still hears "Join the library to borrow games." (403). The desk lends it, as before.

A perk game comes back like every game: staff scan it in or mark it Back on the shelf. Reserving and the borrow queue
still need a plan, and perk games are never posted.

### 1.5 When a perk ends with a game at home

Nothing is taken back or charged. The game stays at home with them, marked `perkEnded` for them and for staff, and they
can't take another on the perk. The email that says the GM perk is resting asks for the book back, and one more email
asks again 7 days later if it's still out (5.5). When staff take a perk, or someone leaves the team, nothing is emailed:
staff sort that in person, and the Library tab shows the game.

### 1.6 A game's books

A GM names up to **3** library books their game uses: on Run a game (`POST /games`, `books`) or later
(`POST /games/:id/books`). Only RPG-shelf books the catalogue knows.

- The books are every session's: a series' later sessions get them as they're added.
- Changing them later changes this session and every later session of the game that hasn't ended (`scope: 'series'`,
  the default for a series), or this session only (`scope: 'session'`).
- **It reserves nothing.** Copies, holds, the queue and loans work exactly as before. It's a note of which table would
  like the book, and when.

### 1.7 Who wants a book, and who's told

A book is **wanted** by each session on the board (`open`, not ended) whose game names it, soonest first.

- **Anyone looking at it** sees that: `GET /library/status` gives each game its next wanted dates.
- **Whoever takes it is told there and then:** the scan's and the desk's answers list the dates and say so in words.
  It never stops the loan.
- **In My Library and on the staff page** a game at home shows who wants it and when.
- **One email** to whoever has it at home, for each game that wants it, the first time the Lair sees that: the dates,
  and that it would be good to bring it back by then (5.3). A game that names the book after it went out is told the
  same way. Never to the GM of the game that wants it: it's with the right person.
- **One nudge** a loan: when a session that wanted it started 7 days ago or more, while it was out, it's still out,
  and the email above went 7 days ago or more (5.4). Never about the borrower's own game.
- Private games want books too; only their GM and staff see the game's name (everyone else sees no title).

### 1.8 Staff give and take

`POST /members/:id/gm-perk` (3.9), with any one of Members, GM games or Library. Give: the perk goes on now, whatever
it was (resting, taken, never had). Take: it's off and stays off. Each is logged with who and an optional note
(`gm_perk_log`), and the member's page shows the last 10.

## 2. Data

Made when the Lair starts (added when missing; nothing to run by hand).

| Table or column | |
| --- | --- |
| `gm_perks` | `customer_id` (key), `status` (`on`, `off`), `source` (`auto`, `staff`: how it last went on), `since` (ms: when it last went on), `off_reason` (`quiet`, `idle`, `staff`, or null), `off_at`, `by` (`auto` or `staff:<customer id>`: who changed it last), `note`, `created_at`, `updated_at` |
| `gm_perk_log` | `id`, `customer_id`, `action` (`on`, `off`), `reason` (`listed`, `played`, `staff`, `quiet`, `idle`), `by`, `note`, `at` |
| `game_books` | one row for each book of each session: `game_id`, `variant_id` (the key together), `product_id`, `title`, `handle`, `shelf_code`, `image`, `position`, `created_at`. Index on `variant_id` |
| `series.details.books` | the books the series gives the sessions it adds later (`[{ variantId, productId, title, handle, shelfCode, image }]`) |
| `library_loans.perk` | `gm` or `staff` for a game that went out on a perk (then `lent` is 1 too); null for every other loan |
| `library_loans.wanted_told` | the games this loan's borrower has been emailed about (a JSON list of series ids, or session ids for one-offs) |
| `library_loans.wanted_told_at` | when that email last went |
| `library_loans.nudged_at` | when the one nudge went (1.7) |
| `library_loans.back_asked_at` | when the second ask for a book whose perk ended went (1.5) |

## 3. Routes

### 3.1 The perk, for its holder: `library.perk`

On `GET /me`'s `library` and on `POST /library/scan`'s `library`. `null` for someone with no perk and no record.

```
perk: {
  kind: 'gm' | 'staff',
  status: 'on' | 'resting' | 'off',      // staff: always 'on'. 'resting': quiet or idle. 'off': staff took it
  covers: 'rpg' | 'any',
  free: true | false,                    // on, and nothing at home on a perk
  loanId: 'ln_…' | null,                 // the game on the slot now (it's in atHome)
  since: 1794600000000 | null,           // gm: when it last went on
  quiet: 0, quietMax: 3,                 // gm, on: quiet sessions in a row since then
  reason: 'quiet' | 'idle' | null        // gm, resting: why
}
```

### 3.2 Loan views

- **The member's** (`library.atHome[]`, the scan's `loan`): adds `perk` (`'gm'`, `'staff'` or null), `perkEnded`
  (true when it went out on a perk that no longer covers it) and `wanted` (3.4's list for this game, `[]` when nobody
  wants it).
- **Staff's** (`POST /library/loans`, `GET /library/loans`, the returns, a member's detail): the same three, and
  `nudgedAt` (ms or null).

### 3.3 `POST /library/scan` and `POST /library/loans`

As before, plus:

- The scan's `message` for a perk loan is `borrowedGm` or `borrowedStaff` (section 4); when the game's wanted, the
  heads-up (`wantedLine`) follows it after a space. A plan loan of a wanted game gets the heads-up after its usual words
  too. The answer adds `wanted` (3.4's list, as the borrower sees it) and `wantedLine`: that line on its own (`message`
  ends with it), so a page can show it apart from the rest, or `null` when nobody wants the game.
- The heads-up names **other** tables' dates: the soonest 3 sessions that aren't the borrower's own game, and how many
  more of those there are. When only their own games want it, it says to bring it along.
- The desk's answer adds `perk` (`'gm'`, `'staff'` or null; `lent` is true for a perk loan) and, when the game's
  wanted, `wantedLine` joins `notice` (after any other notice, a space between).
- New refusals for a scan with no plan: `slotFullGm` / `slotFullStaff` (409), `rpgOnly` (403), `resting` (403).

### 3.4 `GET /library/status`

Each game adds `wanted`: up to 3 sessions that want it, soonest first, and `wantedMore` (how many more there are).

```
wanted: [{ at: 1794700800000, until: 1794715200000, title: 'The Ember Road' | null, mine: false }]
```

`title` is null for a private game unless whoever's asking is its GM or staff. `mine`: they're that session's GM.
Library discovery's game card (`GET /pick/game/:id`, its `availability`) is as it was.

### 3.5 `GET /library/books?q=` (logged in)

The RPG shelf's books for the form's picker, from the catalogue: active listings whose title has every word of `q`
(ignoring case), A to Z, 12 at most; with no `q`, the first 12. 401 logged out.

```
{ books: [{ variantId, productId, title, handle, shelfCode, image, copies }] }
```

### 3.6 `POST /games`

Takes `books`: a list of up to 3 variant ids or product ids (strings or numbers; the same book twice counts once).
Checked with the game's other details, before anything is saved: not a list → 422 `booksList`; more than 3 → 422
`booksMax`; one the catalogue doesn't have as an active RPG-shelf book → 422 `bookUnknown`.

The answer's `game` adds `books` (3.7's list). When listing it switched their GM perk on, the answer adds
`perk: { on: true }`.

### 3.7 `GET /games/:id/books` and `POST /games/:id/books`

For the game's GM (a series: whoever runs it, v18-gm-sessions) or staff with GM games; anyone else 403 `booksOwn`;
404 for no such game.

- `GET` → `{ books, scope }`: `scope` is `'series'` for a session of a series, else `'session'`.
- `POST { books, scope? }`: the same checks as 3.6; 409 `booksCancelled` for a cancelled game. `scope: 'series'` (the
  default for a session of a series) sets them on this session and every later session of the series that hasn't
  ended and that they run, and on the series for the sessions it adds; `'session'` on this one only. → `{ books,
  sessions }` (`sessions`: how many sessions were changed).

A book as a game lists it:

```
{ variantId, productId, title, handle, shelfCode, image,
  copies: 1,          // the catalogue's (1 when it doesn't say)
  out: 0,             // copies at home with anyone
  withYou: false }    // at home with whoever's asking
```

`GET /me`'s `games[]` each add `books` the same way.

### 3.8 `GET /members/:id` (staff, Members)

`member.perk`, the staff view:

```
perk: {
  kind: 'gm' | 'staff' | null,           // 'staff' for someone on the team; null with no record
  status: 'on' | 'resting' | 'off' | 'none',
  source: 'auto' | 'staff' | null, since, reason: 'quiet' | 'idle' | 'staff' | null, offAt,
  by: { customerId, name } | null, note: '',
  quiet: 0, quietMax: 3,
  lastPlayed: ms | null,                 // their last played session's start
  next: ms | null,                       // their next session on the board
  loan: <staff loan view> | null,        // the game on the slot
  log: [{ at, action, reason, by: { customerId, name } | null, note }]   // newest first, 10 at most
}
```

For someone on the team, `kind` is `'staff'`, `status` `'on'`, and the rest describe the GM perk record underneath
(null and `[]` with none).

### 3.9 `POST /members/:id/gm-perk { action: 'give' | 'take', note? }`

Staff with Members, GM games or Library (403 otherwise, v9-team's words). 404 "No member with that customer ID." 422
`action` for anything else. `note`: up to 300 characters.

- `give`: 409 `giveTeam` for someone on the team; 409 `giveOn` when it's on already. Otherwise on now (`source`
  `staff`, `since` now), logged, and they're emailed (5.1).
- `take`: 409 `takeOff` when staff took it already. Otherwise off (`reason` `staff`), logged. No email.

→ `{ perk }` (3.8's).

### 3.10 `GET /gm-perks` (staff with Members, GM games or Library)

Everyone with a GM perk record, on first, then resting, then off, each newest change first, and the team's slots in
use:

```
{ perks: [{ customerId, name, code, ...3.8's fields without log }],
  team: [{ customerId, name, loan }] }    // people on the team with a game at home on the staff slot
```

### 3.11 `GET /floor`: `features.books`

`features` adds `books: true`: this Lair knows a game's books (3.5 to 3.7). A page shows Run a game's book picker only
when it's there, so a page talking to an older Lair shows the form as it was.

## 4. Words (word for word)

Exported from `src/gm-perk.js` as `GM_PERK_WORDS`. `{when}` is "Sun 15 Nov, 6pm".

| Key | Words |
| --- | --- |
| `borrowedGm` | {title} is yours to take home, free with your GM perk. When you're done, bring it to the counter and we'll scan it back onto the shelf. |
| `borrowedStaff` | {title} is yours to take home on your staff slot. Scan it back onto the shelf when you're done. |
| `slotFullGm` | Your GM perk is one book at a time, and {title} is at home with you. Bring it back to the counter to swap. |
| `slotFullStaff` | Your staff slot is one game at a time, and {title} is at home with you. Scan it back in to swap. |
| `rpgOnly` | Your GM perk covers the RPG shelf. Join the library to borrow board games. |
| `resting` | Your GM perk is having a rest until your next game runs. Join the library to borrow in the meantime. |
| `wantedLine`, one session | Heads up: {game} would like this one on the table at the Lair on {when}. Take it by all means, and bring it back by then if you can. |
| `wantedLine`, several | Heads up: tables at the Lair would like this one on {when}, {when} and {when}. Take it by all means, and bring it back in time if you can. |
| `wantedLine`, more than 3 | …on {when}, {when}, {when} and 2 more dates. … |
| `wantedLine`, only their own games | It's down for your own game on {when}: bring it along. |
| `booksList` | Send the game's books as a list. |
| `booksMax` | A game can name up to 3 library books. |
| `bookUnknown` | That isn't one of the library's RPG books. Pick one from the list. |
| `booksOwn` | Only the game's GM or staff can change its books. |
| `booksCancelled` | That game was cancelled, so its books can't change. |
| `action` | Pick give or take. |
| `giveTeam` | {name} is on the team, so they have the staff slot already. |
| `giveOn` | {name} already has the GM perk. |
| `takeOff` | {name}'s GM perk is switched off already. |

A private game in `wantedLine` is "a private game". `{name}` is their first name, or "They" / "Their".

## 5. Emails

Gobgob's, through the Lair's own layout, only when email is set up and the Lair has an address for them. Someone on
the team is never emailed about a GM perk. Each is a notice about the person's own perk or a game they have at home
(an account notice, not marketing: no offer rides along, and it goes whatever their marketing setting says), with one
job and one button. Config `GM_PERK_EMAILS` = `off` stops all five and changes nothing else. **Mo approves each one's
words and trigger before this round goes live.**

| | Goes when | To | Stops | Subject | Button |
| --- | --- | --- | --- | --- | --- |
| 1 | The perk goes on (`listed`, `staff`), or comes back (`played`) | The GM | Once each time it goes on | "Your GM perk is on: borrow an RPG book, free", or "Your GM perk is back" | Browse the RPG shelf |
| 2 | The perk rests (`quiet`, `idle`) | The GM | Once each rest; never when staff take it | "Your GM perk is having a rest" | Run a game |
| 3 | A game wants a book someone has at home, the first run after the Lair sees that (1.7) | Whoever has it | Once a game a loan (a series is one game, whatever sessions it adds); never the game's own GM | "A table wants {title} on {day}" | See it in My Lair |
| 4 | A session that wanted it started 7 days ago while it was out, it's still out, and email 3 went 7 days ago or more (1.7) | Whoever has it | Once a loan; never their own game; never a session from before it went out, or from more than 5 weeks back | "Could you bring {title} back?" | See it in My Lair |
| 5 | A GM perk book still at home 7 days into the perk's rest (1.5) | The GM | Once a loan; not once the perk is back, or it's home | "Could you bring {title} back?" | Run a game |

A subject is under 50 characters, so it fits a phone's inbox: when `{title}` would take 3, 4 or 5's past that, the
subject says "your library book" in its place ("A table wants your library book on Wed 18 Nov", "Could you bring your
library book back?"), and the email still names the book.

1 says what the perk is, how to use it (scan it in My Lair at the shelf, or ask at the counter), what keeps it on, and
that naming their game's book tells whoever has it. 2 says why, that it comes back by itself when a game of theirs
runs with players, and, with a perk book at home, asks for it back. 3 lists each game and its next dates (3 at most a
game) and says nothing's forced. The numbers that show whether they work: perk books borrowed a week, and wanted books
back on the shelf by the session that wanted them.

## 6. The 10-minute run (`gmPerkUpkeep`)

After the series steps, each part on its own, with nothing waited on once it starts reading:

1. GMs of sessions on the board with no record: whether each is on the team is looked up first (Shopify's tags, 10
   lookups a run, and someone Shopify couldn't answer about waits for the next run); the rest go on (20 a run), each
   emailed.
2. Perks that are on: rested when 1.2 says so.
3. Perks that are resting: back on when 1.2 says so.
4. Loans out: 5.3's email for games not told yet, 5.4's nudge, 5.5's second ask (50 emails a run in all).

Listing a game, staff approving one, a game joining an account and My Lair opening switch a new GM's perk on at once
(the same check, without waiting for the run) when the Lair knows they're not on the team: they're the one asking, or
their Shopify tags have been read since the Lair last started (staff listing a game for a GM reads them then). Someone
it knows nothing about waits for the run.

## 7. The theme

Mo picked from the mockups on 14 Nov 2026 ("1.A 2.A 3.A. Happy with everything else. Go live"): the perk as **a card
of its own** in My Library, **a search box** for a game's books on Run a game, and a borrower **told as they take** a
wanted book. The Lair's answers above are what the pages read; with a Lair from before this round none of it shows.

- **My Library** (`assets/lair-my-library.js`): the perk's card first (on with Scan a book, the game on the slot, or
  resting and why, with an ask for the book); a perk game tagged GM perk or Staff slot, never Lent; one whose perk has
  ended marked and quietly asked back (1.5); "A table would like it on…" on a game at home; and the scan's heads-up
  (`wantedLine`) in a box of its own under the usual words.
- **Run a game** (`assets/lair-session-form.js`): Books for the table in step 3, shown when the floor's `features.books`
  is true (3.11): a search of the RPG shelf (`GET /library/books`), up to 3, sent as `books` on `POST /games`.
- **Games I run** (`<lair-game-books>` in `assets/lair-my-library.js`): each game's books and where each one is (at home
  with them, at home with someone, on the shelf), and Change the books (`POST /games/:id/books`, the default scope).
- **A library game's page** (`assets/lair-library.js`): when the next other table would like it, or that it's down for
  their own game, from `GET /library/status`.
- **Staff page** (`assets/lair-staff-perks.js`): a member's GM perk or staff slot with Give and Take it away (each asks
  first), the Library tab's loans (GM perk or Staff slot, Perk ended, Wanted, Nudged) and a GM perks list
  (`GET /gm-perks`).
- **The demo backend** (`assets/lair-demo.js`, the lab) does the same.

## 8. Checks

`test/round37-gm-perk.test.js` (each test names the section its rule is written in): the words; the rules of 1.2 and 1.3 from their text (on at listing and at approval,
never for the team, three quiet sessions, a cancelled session inside and outside 24 hours, idle at 21 days, back when
played, staff give and take and their log, a taken perk never back by itself); one slot, the RPG shelf, the staff
slot's any shelf, plan or no plan, never In Store Only, the scan's refusals; perk games outside a plan's count; a game's
books (the picker, the checks, a series' later sessions, scope); wanted on the status, the scan, the desk and My
Library, private games' titles; the emails, each once, and their subjects; the nudge and its edges; the 10-minute run's
limits; and Cloudflare's SQL limits on every query.

Each rule was also checked the other way round: 100 deliberate breakages of the code (a number changed, a check
dropped, an order swapped), one at a time, and the tests fail for every one.

The pages: `tools/qa/round37-gm-perk/` (its section of `tools/qa/README.md`): the theme's demo at phone and desktop
size, the theme in live mode against this Lair with a fake Shopify, and the new theme against the Lair from before this
round.

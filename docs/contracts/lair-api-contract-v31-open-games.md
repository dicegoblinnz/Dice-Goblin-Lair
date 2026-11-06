# Lair app API: open games, and unbooked pairs from the start of the night (6 Nov 2026)

**Changes only**, on top of v30 (the library round, live 6 Nov) and everything before it (v11-warhammer above all); where they disagree, this file wins.
Times in ms (UTC), shown in Lair time (Pacific/Auckland). Backend: `src/open-games.js`, with small hooks in `src/lair.js`
(reserve, the cancel rule, the confirmation, the 10-minute run), `src/warhammer.js` (the booker's and the player's views)
and `src/core.js` (`eventHolds`). Tests: `test/round31-open-games.test.js`. Theme (the Warhammer and hobby chat's next
step): the reserve sheet's Find me one, Thursday's games to join, the join sheet and the Find a game page.

From Mo's picks in the Warhammer and hobby chat (2 to 6 Nov 2026): open games "On the booking + Discord", joined from
Thursday's event card and on a Find a game page for the next four Thursdays ("Both"); "Free to cancel until it starts"
while nobody's joined; an email that afternoon asking if they're still coming; first names to members only, no names on
Discord; "Warhammer Night's unbooked pairs open to anyone to book from 6pm on the night". **Not live until Mo says yes.**

## 1. Rules

### 1.1 Listing a game

- `POST /events/:id/reserve` (v11) with `looking: { game, size, newPlayers }` and `people: 2` lists the pair as looking
  for a game. Only a logged-in member, only 1 v 1, never with `players` (named opponents), and only on a night paid at the
  counter. `game` and `size` come from the lists (2.1): no free text, so nothing to moderate.
- One listed game a member a night (still on: not cancelled or a no-show).
- Until someone joins, the booking is **the booker alone**: `people` 1, `amount` their own share ($10), `split` false.
  So a game nobody joined never owes more than the booker's $10, at the counter or on their tab afterwards (round 15).
- The booker's confirmation says the game, "Gobgob's finding you one", where it's listed, and that they'll both get an
  email when someone joins.

### 1.2 Who sees what

- Logged out: each game's player is **"A player"**. A member: the booker's **first name**. Never an email, a member
  code, an account, a phone, the booker's last name, or the booking's own id or code: a game's public id is its own
  (`og_…`).
- A taken game leaves the list for everyone but its two players.
- The two players found each other on the list, so they see each other the same way everywhere (My Lair, the join's
  answer, emails): first names only (**"A player"** for a member with no name, never their member code), with no email,
  phone or last name, and the player's ticket goes by the game's id, not the booker's booking code. Staff see everything,
  as for any game. (From the review, 6 Nov 2026.)

### 1.3 Joining

- The first logged-in member to join gets the game (the Durable Object's one-at-a-time read-check-write: two people
  can't both get it). They become the opponent in `booking_players` (v11), and the booking becomes 1 v 1: `people` 2,
  `amount` two shares, `split` true, each paying their own $10 at the counter. Their check-in, stamp and My Lair entry are
  a named player's, as in v11.
- Joining closes 2 hours before the night ends. Not your own game; not while you have a game of your own listed that
  night; not while you're already playing in a game that night.
- The booker gets "Game on: Kiri has joined your game"; the player gets "You're in", with until when they can drop out.

### 1.4 Dropping out and cancelling

- The player can drop out (`POST /open-games/:id/leave`) until `refundHours` (24) before it starts. The booking is the
  booker's alone again, the game is listed again (and its afternoon email can go again), and the booker hears. A share
  they'd paid ahead at the counter is money due back: staff are emailed, as for any cancellation, and it stops counting
  toward the game (a payment of minus that much, `order_id` 'refund', as v21's), so the booker still pays their own.
  A booker who'd paid for both of them has paid more than their game costs now: staff are emailed to refund them the
  difference.
- Either way round, the booking's `paid` follows what's paid toward it: a booker who paid their own $10 ahead has half a
  game paid once someone joins (the player still pays theirs), and a whole one again if they drop out.
- The booker cancels as before (`POST /bookings/:id/update { status: 'cancelled' }`). While nobody's joined it's free
  **right up until it starts** (`cancelRule`: `cancelUntil` is the start, never locked). Once someone has, the usual rule:
  locked in 24 hours before. A player who'd joined hears it's off ("Called off: Sam's game").

### 1.5 The afternoon email

From 2pm on the night (Lair time), before it starts, the booker of a game nobody has joined gets one email: nobody's
joined yet; their tables are saved to play whoever walks in, or paint at the station (free with their own paints); not
coming, cancel free in My Lair before it starts. Once a game; again only after a player drops out. Not for a game listed
from 2pm that day: they've only just said they're coming.

### 1.6 Discord

With the Worker secret `DISCORD_WARHAMMER_WEBHOOK` set (the channel's webhook address, `https://discord.com/api/webhooks/<id>/<token>`;
Discord: the channel → Edit channel → Integrations → Webhooks → New webhook → Copy webhook URL; Cloudflare: Workers &
Pages → dice-goblin-lair → Settings → Variables and Secrets, type Secret), each listed game is posted, without a name,
email or tables:

> A Warhammer 40,000 player is looking for a game on Thursday 12 November, from 6pm. 1,000 points, and new players are welcome.
> Join them: https://www.dicegoblin.nz/pages/warhammer

Once someone joins, the same post becomes "Game on! The Warhammer 40,000 game on Thursday 12 November has its opponent."
(and a link for anyone else looking). Called off, or the night's over: the post is deleted. Mentions are off
(`allowed_mentions: { parse: [] }`), so a post never pings anyone. A post that fails (Discord down) is tried again by the
10-minute run, up to 20 a run. Not set: nothing is posted, and everything else works the same.

The link is the `wargames` page: Theme settings › `page_wargames` when the theme has it, else `/pages/warhammer`.

### 1.7 Unbooked pairs from the start of the night

An event date that locks its tables (`lockTables`, Warhammer night's T8–T21) holds them for the event until it starts.
**From the start** (6pm), its game tables leave the lock and are only marked (`soft`), so a pair nobody reserved can be
booked by anyone, on the booking page or at the counter; its other tables (T16–T17, the painting station) stay locked.
Reserved pairs are taken as before. The floor's `eventHolds` says so, so the theme's booking page follows by itself:
from the start, `ev-<occurrence>` holds only the other tables (hard) and `ev-<occurrence>-spots` all the game tables (soft).

## 2. Routes

### 2.1 `GET /open-games` (`?occurrence=<id>` for one night)

→ `{ choices, dates, discord }`. `discord`: true while listed games go to Discord (the webhook is set), so the
website mentions Discord only then; the booker's confirmation does the same.

- `choices`: the games a listing can be, in order, each `{ key, name, sizes: [{ key, name }] }`:

| key | name | sizes |
| --- | --- | --- |
| `40k` | Warhammer 40,000 | `combat-patrol` Combat Patrol, `1000` 1,000 points, `2000` 2,000 points, `any` Any size |
| `aos` | Age of Sigmar | `spearhead` Spearhead, `1000`, `2000`, `any` |
| `kill-team` | Kill Team | none |
| `old-world` | The Old World | `1000`, `2000`, `any` |
| `bolt-action` | Bolt Action | `1000`, `any` |
| `other` | Something else | none |

  The reserve sheet may say "Not fussed" for `any`; the list says "Any size".
- `dates`: the game nights (events with game tables) of the next 28 days that haven't ended, at most 8, soonest first,
  each `{ occurrenceId, title, start, end, spots: { total, free }, games }`. `games`, oldest listing first: `{ id, game,
  gameLabel, size, sizeLabel, newPlayers, tables ('T10 + T11'), start, player ('Sam' or 'A player'), status ('looking' |
  'on'), yours? ('booker' | 'player'), opponent? (to the booker of a game that's on: the player's first name) }`. A
  game still looking shows until joining closes; one that's on, only to its two players.

### 2.2 `POST /events/:id/reserve` (v11) with `looking`

`{ name, email, phone, people: 2, spot?, looking: { game, size?, newPlayers? } }` → as v11, `booking` with `openGame:
{ id, game, gameLabel, size, sizeLabel, newPlayers, status: 'looking', opponent: null }` and `gameSize: '1 v 1'`.
Errors, after v11's name, email, phone and rate checks, in this order: `401 login`; `422 size` (not 1 v 1); `422 both`
(players too); `422 game`; `422 points` (a size the game hasn't, or none when it has sizes); `409 twice`; then v11's
`422 spot`, `409` taken; `422 online` (a night paid online).

### 2.3 `POST /open-games/:id/join`

→ `{ game (2.1's, with yours: 'player'), booking (their My Lair entry, 2.5) }`. Errors, in this order: `401 loginJoin`;
`404 gone` (no such game, or the booking isn't on); `403 own`; `409 taken`; `409 closed`; `409 listed`; `409 already`.

### 2.4 `POST /open-games/:id/leave`

→ `{ left: true, game }`. Errors: `401 loginJoin`; `404 notIn`; `409 lockedLeave`.

### 2.5 `GET /me`

- The booker's booking: `openGame: { id, game, gameLabel, size, sizeLabel, newPlayers, status ('looking' | 'on'),
  opponent (first name, or null) }`, `gameSize: '1 v 1'`; `cancelUntil` is the start and `locked` false while it's looking.
- The player's entry (v11's `playerBookings`, `playerOf` the booker): `openGame: { id, game, gameLabel, size, sizeLabel,
  newPlayers, status: 'on', canLeave, leaveUntil }`. `canCancel` stays false: the player drops out with 2.4. `ref` is the
  game's id (`og_…`), `playerOf.name` and `gamePlayers` first names only (1.2).
- The booker's `gamePlayers` for an open game: first names, no `email`.

### 2.6 `POST /internal/open-games { at? }`

The 10-minute run's part at a fixed time (the live checks' clock): the afternoon emails, then the Discord posts not right
yet. → `{ nudged, posted }`.

## 3. Words (word for word, `OPEN_GAME_WORDS`)

| key | words |
| --- | --- |
| `login` | Log in to list a game, so it shows in My Lair and Gobgob can tell you when someone joins. |
| `loginJoin` | Log in to join a game, so it shows in My Lair. |
| `size` | An open game is 1 v 1. For 2 v 2, add the other players. |
| `both` | Add your opponent, or let Gobgob find you one: not both. |
| `game` | Pick a game from the list. |
| `points` | Pick a size from the list. |
| `online` | This night's game tables are paid online, so add your opponent instead of listing a game. |
| `twice` | You've listed a game for this night already. It's in My Lair. |
| `gone` | That game isn't listed any more. Pick another, or list your own. |
| `own` | That's your own game. Someone else will join it. |
| `taken` | Someone's just joined that game. Pick another, or list your own. |
| `closed` | That night's nearly over, so the game can't be joined now. |
| `listed` | You've listed a game of your own that night. Cancel it in My Lair first, or wait for someone to join it. |
| `already` | You're already in a game that night. It's in My Lair. |
| `notIn` | You're not in that game. |
| `lockedLeave` | It's less than 24 hours to the game, so you can't drop out online now. Let Sam know, or give us a call. |

## 4. Data

One new table, made on every start: `open_games (id, booking_id UNIQUE, occurrence_id, game, size, new_players,
player_id, joined_at, nudged_at, post_id, post_state, post_tried_at, created_at, updated_at)`, indexed by night. The
player is a v11 `booking_players` row (`player_id`). No other table changes; nothing is backfilled.

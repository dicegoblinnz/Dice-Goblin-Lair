# Lair app API: private games (17 Oct 2026)

**Changes only**, on top of v18-cash and everything before it; where they disagree, this file wins. Times in ms (UTC),
shown in Lair time (Pacific/Auckland); money in cents. Backend: `src/private-games.js` (the rules and the three routes),
`src/lair.js` (the routes, booking a seat, saving a seat every week, making sessions, `GET /floor`, `GET /me`),
`src/core.js` (`publicGame`) and `src/interest.js`. Theme: `assets/lair-join.js` (invite keys and the join form),
`assets/lair-games.js` (the sessions board's sheets: `?invite=`, the locked game, the GM's Who can join),
`assets/lair-session-form.js` (Who can join on a new game), `assets/lair-play.js` and `assets/lair-calendar.js` (the
booking page and the events calendar), `assets/lair-staff.js` (the staff page's GM games manager), `assets/lair-core.js`
and the demo (`assets/lair-demo.js`). Tests: `test/round18-private.test.js`; browser checks:
`tools/qa/round18/private.mjs`.

Mo (17 Oct, 8:20am): "I want my gms to be able to have a private game, and it becomes an invite only game. But they can
toggle a register interest button if they want otherwise it is locked to the public." He picked: a private game still
shows, as Private, invite only, and the GM shares an invite link.

## 1. Rules

### 1.1 A private game

- A game (a one-off, or every session of a weekly, fortnightly or flexible game) is **private** or not. A private game
  is **invite only**: it shows on the TTRPG sessions page, the booking page and the events calendar as Private, invite
  only, with its details, but nobody can join it without its **invite link**.
- Its invite link is the TTRPG sessions page with `?invite=<key>`: 20 letters and numbers with no look-alikes (no i, l,
  o, 0 or 1), from `crypto.getRandomValues`. Every session of a series shares one key, and sessions made later get it
  too.
- The game's GM and staff with GM games never need the key. A weekly regular who's in already doesn't either (they can
  change who's coming).
- **Register interest** (off unless the GM turns it on): while it's on, anyone can say they're interested in a private
  game (round 9's I'm interested), and the GM's email about them carries the invite link to send if they're a good fit.
  While it's off, the game takes no interest (`403 noInterest`) and is shut to anyone without the link.
- Seats booked with a link stay when the GM makes a new link or makes the game public.

### 1.2 Making a game private, and back

- Who: the game's GM (a series: its GM) and staff with GM games (`sessions`). Others: `403 notYours`.
- A new game (`POST /games`, the GM's Run a game or staff's Make a session) is private with `private: true`, and takes
  interest with `interest: true` as well. Its reply's `game` has its `invite` (1.4).
- `POST /games/:id/private` changes it later (2.1). For a session of a series it's that session and every later one the
  caller runs (scope `series`, the default; `session` is just that one), and the series keeps it for sessions made later.
- A game made private gets a key when it has none. One made public again keeps its key, so the same link works if it's
  made private again.
- A cancelled game can't be changed (`409`).

### 1.3 A new link

- `POST /games/:id/invite/new` (2.2): a new key for the game (a series: every session that had the old key, and the
  series for sessions made later). The old link stops working at once; seats booked with it stay. Only a private game
  has a link (`409 notPrivate`).

### 1.4 Who sees the link

- `game.invite: { key, url }`, on a private game only:
  - `GET /floor`: for the game's GM, and staff who see the staff floor (Check-in, Tables, GM games or Events);
  - `GET /me` `games` (the GM's own), the `POST /games` reply, and the replies of 2.1 and 2.2.
- Everyone else gets `private: true` and `interestOpen` (2.4), never the key. It's not in the events feed, the players'
  emails or any error.

## 2. Routes

### 2.1 `POST /games/:id/private`

`{ private: boolean, interest?: boolean, scope?: 'series' | 'session' }` (interest left out: as it was; a public game
never takes it) → `{ game, sessions }`, `game` as the board has it with its `invite`, `sessions` how many changed.
Errors: `401 login`, `404` (no game), `409` (cancelled), `403 notYours`, `422 private` (not true or false), `422
interest`.

### 2.2 `POST /games/:id/invite/new`

→ `{ game, sessions }` (`game` with its new `invite`). Errors: `401 login`, `404`, `409` (cancelled), `403 notYours`,
`409 notPrivate`.

### 2.3 `GET /games/invite/:key` (anyone with the link)

→ `{ game }`: the private game the key is for, as the board shows it, with `invited: true`: its next session that
hasn't ended, open or full. A key that isn't one, or has nothing to come: `404 badInvite`.

### 2.4 Changed

- `GET /floor` and every game view: `private` (boolean) and `interestOpen` (a private game taking interest), and
  `invite` as 1.4.
- `POST /bookings` with `kind: 'gm-seat'` and `POST /games/:id/join-series`: `invite` (the key) for a private game;
  without it, or with a wrong one: `403 invite`.
- `POST /interest` for a private game's session while it isn't taking interest: `403 noInterest`.
- The GM's "Someone wants in!" email for a private game says it's private and carries their invite link.

## 3. Words (`PRIVATE_WORDS`, word for word)

| key | words |
| --- | --- |
| invite | This game is invite only. Ask the GM for the invite link. |
| badInvite | That invite link doesn't work any more. Ask the GM for a new one. |
| noInterest | This game is invite only, and the GM isn't taking interest right now. Ask them for the invite link. |
| private | private is true or false. |
| interest | interest is true or false. |
| notYours | Only the GM of this game, or staff with GM games, can change who can join it. |
| login | Log in to do that. |
| notPrivate | This game isn't private, so it has no invite link. Make it private first. |

## 4. Storage

`games.private` (0 or 1), `games.interest_open` (0 or 1) and `games.invite_key` (text), made on start when missing, and
the index `games_invite` on `invite_key`. A series' `details` keep `private`, `interestOpen` and `inviteKey`.

## 5. The theme

- **The key in the browser**: `lair-join.js` keeps the keys followed in `localStorage` (`dg-lair-invites`, by series or
  one-off id, the 30 most recent), so logging in and coming back, the events calendar and a later visit know them; a
  key the Lair app refuses (`403`) is forgotten. Logging in from a seat's form comes back with `&invite=` too.
- **`?invite=<key>`** on the TTRPG sessions page: the game opens (on its day, on the booking page) with "You're invited!
  Your invite link lets you join this private game.", the key is kept, and the link leaves the address. A link that
  doesn't work says so.
- **Without the link**: Private on the game's picture and tags; "Private: invite only" where its seats would be; no
  Join or Save my seat anywhere (the sheet, the day's list, the map, the calendar, Looking for players); the sheet's
  foot says "This game is invite only. Ask <GM> for the invite link." or, while it takes interest, "Interested? Tell
  <GM>, and they can send you the invite link." with I'm interested.
- **The GM** (and staff with GM games) on their game: **Who can join**: Anyone (Make it private) or Private · invite
  only, with the invite link (Copy), Let people register interest, New link (asks first) and Make it public. Share
  shares the invite link. Run a game and Make a session ask **Who can join** on the Players step (Anyone, Invite only,
  and Let people register interest), and the Game listed summary has the link to copy.
- **The staff page**: Private on the GM games list and the manager's badges, and the manager's Who can join: the link
  (Copy), Take interest or Stop taking interest, New link (two taps) and Make it public or private (two taps).

## 6. Good to know

- A private game's details stay public (title, GM, time, blurb): it's the seats that are invite only.
- Anyone with a link can pass it on. If it gets around, the GM makes a new one.
- Staff can still add anyone to a private game themselves (Add players, Reserve a seat).

# Lair app API: a GM sees their players on every session (17 Oct 2026)

**Changes only**, on top of v18-private and everything before it; where they disagree, this file wins. Times in ms
(UTC), shown in Lair time (Pacific/Auckland). Backend: `src/lair.js` (`waitingIn`, `savedRegulars`, `gamePlayers`,
`floor`, `messagePlayers`). Theme: My Lair's Games I run (`assets/my-lair.js`), the GM page's Your game and roster
(`assets/lair-games.js`) and the demo (`assets/lair-demo.js`).

Mo (17 Oct, 11:15pm): "I have a user who is asking me that he wants to see his players etc. if you see the mobile view I
can see my players but he cannot see his please make it that all gms can see their players across the site".

## 1. What was wrong

Weekly regulars are booked into a series' **next** session only, and roll forward as each session ends (maintenance's
`rollSeries`, every 10 minutes). Every session after the next one holds their seats (`held`, counted in `taken`) with
nobody booked. A GM's player lists only listed bookings, so any session after the series' next one said "3 of 6 seats
taken" over "No players yet".

Dan's Icewind Dale made it worse: staff gave Dan the game from the session **after** the series' next one, so the first
session in his Games I run was one where his three regulars were only held. (The next session, 23 Oct, isn't on his
account: staff change its GM to him, just that session, on the staff page.)

## 2. Rules

### 2.1 Saved seats are players

- A session's players (`players`, for its GM and staff) end with the regulars whose seats it saves but hasn't booked yet:
  each player of each regular's party, `saved: true`, `regular: true`, `member: true`, `ref: null` (no seat code yet),
  `paid: false`, `arrived: false`, and the first of a party brings their player profile (`pronouns`, `favouriteGames`,
  `about`) as a booked seat's does. Never an email or a mobile.
- They're the regulars maintenance will seat there, in its order: first to join first, each while their seats fit in
  the seats that aren't booked or kept for new players (one whose party doesn't fit keeps nothing from the next), so the
  names match who gets booked once the session before ends.
- Only for a session that hasn't started and isn't cancelled, in a series that's still on. A regular with a seat there
  already (booked, or one they cancelled: they're skipping it) is listed as that seat, or not at all, never twice.
- `taken` and `held` don't change. The seats kept for new players stay "taken" with no names, for GMs as before
  (v18-gm-sessions 1.6).
- `roster` (whoever runs the game) is still one row per booking; the theme adds the saved regulars from `players`.

### 2.2 The series' GM sees every session's players

- On the board (`GET /floor`), whoever runs a series now (`series.gm_customer_id`, as `runsSeries`) gets `players` for
  every session of it they can see, a session someone else runs included (the website shows them each session of their
  series as their game). `GET /me`'s Games I run still lists only the sessions they run themselves.

### 2.3 Messages reach saved regulars

- "Message your players" for one session (`scope: 'session'`) reaches its saved regulars too. A GM who runs only some
  sessions of a series, sending to every session, reaches the regulars saved in their own sessions as well as the seats
  booked there. Everyone once.

## 3. Routes

- `GET /me` `games[].players` and `GET /floor` `games[].players`: as 2.1 (and 2.2 for the floor).
- `POST /games/:id/message`: as 2.3; `sent` counts them.

No new routes, columns or words from the Lair app.

## 4. The theme

- **My Lair, Games I run.** A saved regular's row has the badge **Regular** (a booked seat keeps Paid or Pays at the
  counter), and under the list, when any are saved: **"Regulars: Gobgob saves their seat every week."** (fortnight, or
  session, for those games).
- **The GM page, Your game.** A saved regular's row has the badge **Regular**. For whoever runs the game (the roster),
  each saved regular is a row with the badge Regular and **"Seat saved: booked once the session before ends"**, with no
  Remove (there's no seat to take off yet).
- The demo does the same (`savedMembers`, `savedPlayers`, and `runsSeriesOf`: whoever runs a series' last session).
- Checks: `test/round18-gm-players.test.js` (6 tests, both time zones) and `tools/qa/round18/gm-players.mjs` (35 checks,
  phone and desktop, axe, 320 to 430 wide).

# Lair app API: open seats for launch, and taking a regular off every session (16 Oct 2026)

**Changes only**, on top of v18-gm-sessions and everything before it; where they disagree, this file wins. Times in ms
(UTC), shown in Lair time (Pacific/Auckland). Backend: `src/admin.js` (the owner's job), `src/gm-sessions.js` (Remove)
and `src/lair.js` (`endRegular`, shared with `POST /series/:id/leave`). Theme: the staff page's GM games tab
(`assets/lair-staff.js`), the GM page (`assets/lair-games.js`), `assets/lair-core.js` and the demo (`assets/lair-demo.js`).

Mo (16 Oct, 10:27pm): "Can you help remove all the players from the games and have them be bookable so that players are
able to join I am launching soon and will want players to all sign up on the website for their respective games and
join the sessions and give me the ability to kick players out of the session after they join incsse someone who is not
supposed to be there is. So my staff can handle it etc."

## 1. Rules

### 1.1 Open seats (the owner's job `games.openSeats`)

- The players each group already had (round 11's `offlinePlayers`, "5 of 6" from Mo's GM list: counted as seats taken,
  never named, never booked here) come off **every session that hasn't started** and off **every series**, so sessions
  the daily top-up makes later have none either. Their seats are open to book, online or by staff, like any seat.
- A session already under way keeps its count: nobody books into it now, and the group's at the table.
- Seats booked through the Lair, weekly regulars and invites to keep a seat every week stay as they are. The job lists
  them (names only), so staff can keep them or take them off on the staff page.
- No email to anyone. `dryRun` changes nothing and answers the same.

### 1.2 Taking a player off every session (`scope: 'series'`)

- Remove (round 18's `POST /games/:id/players/:ref/remove`) takes a seat off one session; for a weekly regular that's a
  skip, and maintenance seats them again at the next session, as before.
- With `scope: 'series'`, a regular's seat comes off **and they stop being a regular**: no seat is saved for them again,
  and their other seats the series saved them in sessions still to start are freed, every one, as staff stopping a
  regular does (`POST /series/:id/leave { customerId }`). A seat among those paid ahead at the counter is a refund due,
  and the staff are emailed. Seats they booked themselves, one at a time, stay theirs.
- Who: whoever can Remove (staff with GM games, or the session's staff GM until it ends), and, for a regular's seat,
  only someone who speaks for the series: staff with GM games, or the series' GM now (round 18's `runsSeries`). A staff
  GM running one session of a series given to someone else gets `403 stopNotYours`, and nothing changes.
- A seat that isn't a regular's still on (a one-off seat, or a regular who's left already) is just taken off.
- No email to the player, and the GM isn't emailed (as Remove).

## 2. Routes

### 2.1 `POST /games/:id/players/:ref/remove { scope? }`

`scope`: `'session'` (the default) or `'series'`. → `{ booking, refund, regular, game }`, where `regular` is `{ stopped:
true, freed }` (freed: their other seats to come that were freed) when there was a regular to stop, `{ stopped: false,
freed: 0 }` if they left while the seat came off, and `null` otherwise. Errors, in this order: `404` game; `401 login`;
`403 notYours`; `403 over`; `422 scope`; `404 noSeat`; `403 stopNotYours`.

### 2.2 The owner's job `games.openSeats { dryRun? }` (a row in the config database's `admin_jobs`)

`dryRun`: `true` (or `"true"`) changes nothing; anything else but `false`, `"false"`, `0` or none counts as a dry run
too, so a typo never runs it. → `{ dryRun, games: [{ id (the series, or a one-off session), title, gm, sessions (how
many to open), offlinePlayers (the next session's), next (ms, null for a series with none to come), when }], sessions,
series, players (the games' counts added up), booked: [{ ref, title, when, name, people, regular, account, paid }],
regulars: [{ title, name, people }], invites: [{ title, name }] }`. Never an email or phone.

Queue it (only someone who can write to the config database, the Cloudflare account, can), and the 10-minute cron runs
it:

```sql
INSERT INTO admin_jobs (id, kind, payload, status, created_at) VALUES ('open-seats-dry', 'games.openSeats', '{"dryRun":true}', 'pending', strftime('%s','now') * 1000);
```

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `stopNotYours` | Only staff with GM games, or the GM who runs this weekly game, can take a regular off every session. Take them off just this session, or ask the staff. |

(`GM_SESSION_WORDS` in `src/gm-sessions.js`.)

## 4. The theme

- **Staff page, GM games, a session's Players.** A regular's seat: Remove asks **"Take Kai off just this session, or
  every session?"** with Just this session (a skip, as before: Gobgob saves their seat again next time), Every session
  (they stop being a regular: their seats to come are freed) and Keep them. Any other seat keeps the two taps (Tap
  again to remove).
- **The GM page, Take a player off** (staff, and a staff GM in their own game): for a regular, the sheet asks the same:
  Keep them, Just this session, Every session.
- The demo does the same.

# Lair API contract v13-feeds: follow a game

Round 13 (10 Oct 2026). Mo, looking at five ideas for the calendar: "I did like option 5 but I didn't want to get rid of
what we have. Is there a way to have both? Like a see what we have page and the actual booking page which is what we
have?" The calendar stays the booking page. The theme's new **Our games** page (`/pages/our-games`) shows a tile per game
with its night, its next dates and a **Follow** button, and every button that books or signs up opens the right date in
the calendar. Follow subscribes people's own calendar app to one game's dates, which this round adds.

## 1. `GET /feeds/<key>.ics` (public)

Served on the Lair app's own address (`https://<worker>/feeds/<key>.ics`) and through the store's app proxy
(`https://www.dicegoblin.nz/apps/liar/feeds/<key>.ics`, which the Our games page uses: the store's own name in people's
calendar settings). `HEAD` answers the same way. Nobody needs to be signed in, and nobody is looked up.

**key** (lower case letters, digits and dashes):
- a game: `feedSlug` of the event's **Game** field, or of its **title** when Game is empty. Every event with that key is
  in it, so Magic's Monday and Wednesday entries are one feed, and Blood on the Clocktower's October one-off sits with
  its monthly series.
- `kind-<kind>`: every event of one kind (the `lair_event` definition's Type), like `kind-tcg` for every card night.
- `all`: every event.

`feedSlug` (exported from `src/reminders.js`; the theme's `assets/our-games.js` has the same function): accents dropped
(Unicode NFD, combining marks removed), `&` as " and ", lower case, every run of anything other than a-z and 0-9 a single
dash, no dash at either end, 80 characters at most. "Magic: The Gathering" is `magic-the-gathering`, "Pokémon" is
`pokemon`, "Oddity Alley" (no Game) is `oddity-alley`.

**200**: `text/calendar; charset=utf-8`, `Content-Disposition: inline; filename="dice-goblin-<key>.ics"`,
`Cache-Control: public, max-age=900`. One `VCALENDAR` with:
- `X-WR-CALNAME`: "<Game> at Dice Goblin" ("Magic: The Gathering at Dice Goblin"), "<Kind> at Dice Goblin" ("Card nights
  at Dice Goblin") or "Events at Dice Goblin". `X-WR-CALDESC` says where to sign up or book. `X-WR-TIMEZONE` is the
  Lair's time zone. `REFRESH-INTERVAL;VALUE=DURATION:PT6H` and `X-PUBLISHED-TTL:PT6H` ask calendar apps to fetch it again
  every 6 hours (each app picks its own, from a few hours to a day).
- One `VEVENT` per date (`eventOccurrences`, the same dates as the calendar and the floor) from 14 days ago to the booking
  horizon (`lair_horizon_days`, the calendar's last day), in date order. An event that runs several days (Oddity Alley's
  weekend) is one `VEVENT` a day. Skip dates and dates after Repeat until are left out.
- Each `VEVENT`: `UID` `<handle>-<YYYY-MM-DD>@dicegoblin.nz` (the date id with anything but letters, digits, dots, dashes
  and underscores as a dash: the same UID as that date's own calendar file, `GET /ics/<id>.ics`), `DTSTAMP` now,
  `DTSTART` and `DTEND` in UTC, `SUMMARY` the event's title, `DESCRIPTION` the price line the reminder email uses
  ("$10 a person, paid at the counter", "Free entry", a price note as written) and the calendar link, `LOCATION` "Dice
  Goblin, <the store's address>", and `URL` the calendar link (`/pages/events-calendar#event=<handle>@<date>`).
- Lines end in CRLF and are folded at 75 octets (RFC 5545), as the per-date calendar file.

Because each date keeps its UID, a date moved in Shopify (a new time, a new day for a one-off) moves in people's
calendars at their app's next fetch, a skipped or deleted date disappears, and a new one appears.

**404** (`text/plain`, `no-store`): no event has that key. "There's no game by that name on the Dice Goblin calendar."

**503** (`text/plain`, `no-store`, `Retry-After: 900`): the Lair only has its built-in defaults (Shopify didn't answer
when it last read the events). "The Dice Goblin calendar can't be read just now. Your calendar app will try again
soon." Never an empty calendar: a subscribed calendar replaces everything with what it fetched, so an empty one would
wipe the dates from everyone's calendar until the next fetch.

## 2. The theme's Our games page (built with this round)

- `templates/page.our-games.json`: the page intro and `sections/our-games.liquid`, on the Shopify page `our-games`
  ("Our games"). Menus: "Our games" in `dg-main-menu` and `dg-footer-lair` (the new theme's own menus).
- Tiles come from the `lair_event` entries (the same ones the calendar reads), one per game (Game, else title, without
  case), card nights first, then the rest by kind, each in weekday and time order. The tile shows the official picture,
  the first paragraph of the description (from a repeating entry when the game has one), the price, the night ("Mondays
  and Wednesdays, 6pm to 10pm"; "Usually the fourth Sunday of the month" when a one-off sits with a series), the next
  dates inside the horizon (each opens its sheet in the calendar, `#event=<handle>@<date>`), and what's left on the next
  date (game tables, places, "12 coming"). Reserve a game table and Sign up open the next date's sheet in the calendar,
  where the booking happens as before.
- A TTRPG tile from the floor's sessions: sessions with seats in the next week and a button to the TTRPG sessions board.
- Today at the Lair: what's on today (events and sessions), above the tiles.
- Follow: a dialog with Apple Calendar (`webcal://` link), Google Calendar (`https://calendar.google.com/calendar/r?cid=`
  the webcal link), Outlook (`https://outlook.live.com/calendar/0/addfromweb?url=…&name=…`) and Copy link, all for
  `<origin>/apps/liar/feeds/<key>.ics`. "Follow every card night" in the card nights heading uses `kind-tcg`.
- The calendar (`sections/lair-play.liquid`) links to the page above its tabs ("See all our games") once the page exists.

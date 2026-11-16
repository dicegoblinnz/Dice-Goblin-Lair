# Lair API contract v40-walkins: walk-ins from Google ads

Round 40 (16 Nov 2026). From Mo, the night the first Google search campaign went live: "Can you set it up for me to
track who actually walks in?"

The code: `src/walkins.js` (the click, the walk-ins and the list), `src/newplayers.js` (`firstPaidSession`, which
`paidSession` now uses), `src/lair.js` (the routes, the columns and the click on `createBooking`, `joinSeries`,
`joinEvent` and `reserveSpot`) and `src/index.js` (`/ads/walkins.csv`). The theme: `assets/theme.js` and
`assets/lair-core.js`. Tests: `test/round40-walkins.test.js`.

## Why

Google Ads only sees clicks and website bookings. The Lair knows who actually came in and paid. Telling Google which
clicks became a first paid visit lets the campaign learn from real new players, and gives the Monday numbers a count
Google can't inflate.

## 1. The click

- Google adds `gclid` to the address of an ad click. The website keeps the latest one this browser arrived by for 90
  days (`localStorage['lair-click']`: `{ gclid, at }`), separate from round 24's first-touch ad tags.
- It goes to the Lair as `click: { gclid, at }` on `POST /bookings`, `/events/:id/join`, `/events/:id/reserve` and
  `/games/:id/join-series`, the same requests that carry `ad`, and once a logged-in member's GET /me has answered, as
  `POST /me/click { gclid, at }` → `{ saved }` (401 logged out; 404 for someone the Lair hasn't met yet).
- The Lair keeps it on the member: `members.click_gclid`, `members.click_at`. The latest click stands; an older one
  never replaces a newer one. Staff bookings made for someone never carry one.
- A click is kept only when its ID is 20 to 300 letters, numbers, `_` or `-`, and it's no older than 90 days. A click
  never stops a booking.

## 2. A First visit

A member's first paid session at the Lair, by round 24's rule (`paidSession`: they came in and paid for themselves),
counts as a First visit for their click when:

- it started after the click, and within 90 days of it;
- they hadn't been to Dice Goblin before the click (`playedBefore`);
- it was within the last 60 days.

Nothing is stored: it's worked out each time, so a session taken back (a no-show, a cancellation) drops off.

## 3. The list

`GET /ads/walkins.csv` on the Lair app's own address (`https://dice-goblin-lair.dicegoblinnz.workers.dev`), for Google
Ads' Data Manager to read every day:

```
Google Click ID,Conversion Name,Conversion Time,Order ID
<gclid>,First visit,2026-11-01T14:00:00+13:00,fv-<session id>
```

Data Manager reads the first line as the column names, so there's no `Parameters:TimeZone` line: each time carries
Auckland's offset (+13:00 in summer, +12:00 in winter).

- The Order ID is the session's own random ID, so a row read again on later days is counted once.
- Only the click ID and the time go to Google: no name, email or phone.
- Only with the list's password, `ADS_FEED_KEY` in the config database (at least 24 characters; never in this public
  repository): the username `google` and that password. `?key=<password>` also works, only for a tool that can't send
  a username and password, since an address with the password in it can end up in logs. Anything else is a 401. With
  no password set there's no list.

# Lair API contract v20-sessions-feed: the TTRPG page's sessions in the page

Round 20 (26 Oct 2026). From the website lab: the TTRPG sessions page (`/pages/gm-games`) is one of the site's top
landing pages and can be found on Google again (24 Oct), but the HTML Shopify serves has no sessions in it. The board
(`gm-board`, `lair-play`) fetches them from `GET /proxy/floor` once the page's script runs, so search engines and AI
search tools, which mostly don't run it, find a page with no games on it. Google's event listings don't run in New
Zealand (its Event structured data guide, updated 8 Sep 2026, lists nine countries), so Event markup wouldn't help.
Mo picked "Sessions in the page": the next two weeks of public sessions printed in the page itself, with GM names and
private games left out.

## 1. What the Lair app writes

A shop metafield, written by the 10-minute health check (`checkConnection` → `syncSessionsFeed`, `src/sessions-feed.js`):

- **namespace** `lair`, **key** `sessions`, **type** `json`, on the store itself (`metafieldsSet` with the shop's id).
  A namespace the store owns, so the theme reads it in Liquid as `shop.metafields.lair.sessions.value`. It needs no
  metafield definition and isn't in the Storefront API.
- Written only when what's in it changes (a session listed, changed, cancelled or filling up), and at least once a day
  anyway, in case it was removed in Shopify admin. A failed write records nothing, so the next run tries again, and
  the health check's `connection` record says why (`sessionsFeed: { error }`). A write that worked shows there as
  `sessionsFeed: { count, written: true }`; a run with nothing new says nothing.
- No new access scope: Shopify's docs give every app on the store read and write access to metafields in a namespace
  the store owns. If Shopify ever turns it away, `sessionsFeed.error` says so.

## 2. The value

```json
{
  "v": 1,
  "updated": "2026-10-26T01:10:00.000Z",
  "days": 14,
  "sessions": [
    {
      "id": "gm_…",
      "title": "The Sunless Citadel",
      "system": "D&D 5e",
      "start": "2026-10-31T05:00:00.000Z",
      "end": "2026-10-31T09:00:00.000Z",
      "schedule": "weekly",
      "newPlayers": true,
      "price": 1500,
      "seatsLeft": 3,
      "full": false
    }
  ]
}
```

- **v**: the shape's version. The theme reads `1`; a new shape gets a new number.
- **updated**: when it was made (UTC). **days**: how far ahead it reaches (14).
- **sessions**: soonest first (then by title), at most 40.
  - **id**: the session's id, as on the board, so `#game=<id>` on the TTRPG page opens it.
  - **title** (up to 80 characters) and **system** (up to 40), as the GM wrote them.
  - **start**, **end**: UTC ISO times. Liquid's `date` filter shows them in the shop's time (Pacific/Auckland).
  - **schedule**: `one-shot`, `weekly`, `fortnightly` or `flexible`.
  - **newPlayers**: the game's level is `new` ("New players welcome").
  - **price**: the usual seat price in cents (the table fee plus the GM's fee), as the board shows it.
  - **seatsLeft**: seats less those taken, as the board counts them (regulars' held seats and seats kept for new
    players are taken). **full**: no seats left.

## 3. What's in it, and what isn't

Only what the public board already shows someone logged out (`GET /floor` with no customer), less:
- the GM's name and bio (Mo, 26 Oct 2026: a page Google reads makes GM names searchable);
- private games (invite only, contract v18-private), and sessions pending, cancelled or already started;
- the blurb, tables, room, players, interest, safety notes and everything else the list doesn't need.

A weekly game shows its next session only, as on the board (contract v5); while that session is on, the game isn't in
the list, and the one after it comes in once it ends. A free session shows its usual seat price, and seats kept for new
players count as taken, as on the board (contract v18-gm-sessions: both are staff-only).

## 4. The theme (website lab first)

`snippets/lair-sessions-list.liquid` prints the list from `shop.metafields.lair.sessions.value`, day by day, each day
headed with its full date ("Monday 26 October, today"), each row's times also as `<time datetime>`, and each session
linking to `#game=<id>`. The `lair-play` section shows it on the TTRPG page under its own heading (Theme settings:
Show the next two weeks' sessions, Sessions heading). Shopify's page cache can keep a page a minute or two behind the
metafield, so the page leaves out sessions that have started; and since the app writes at least once a day, a list
whose `updated` is two days old or more isn't shown at all. `lair-play.js` redraws the rows from the board's own data
once it loads, by the same rules (a weekly game's session marked `nextOnly`, so staff and its GM, who get every
session, see the same list), which also keeps it right on the lab's demo data; when the Lair app can't be reached, the
printed list stays. With no metafield (the Lair app down, or before this round), the page shows no list and the board
works as before.

Shopify's own Liquid ends an output tag at a single `}`, so the script's placeholders in the words are `%PRICE%`,
`%NUMBER%` and `%DATE%`, never braces: Shopify's GitHub sync skips a file it can't parse without saying so (Theme Check
and the theme mock both accept it).

## 5. Tests

`test/round20-sessions-feed.test.js`: who and what is in the feed (exactly its ten fields), nothing about the GM or the
players booked in, the write and when it happens again, a weekly game rolling on, free sessions and seats for new
players, Shopify refusing or answering with no metafield, and no Shopify at all. The theme: `tools/qa/round20/sessions.mjs`
on the theme mock (the page as served and with its script, phone and computer, the app down, an empty and an old list,
no metafield, Book a table, and demo mode).

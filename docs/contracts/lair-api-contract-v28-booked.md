# Lair API contract v28: "Booked a session" for the ad platforms

Round 28, 1 November 2026, before the ads start on 9 November. The ads plan's tracking list: "A 'Booked a session' event
when a table, TTRPG seat or event booking is confirmed, sent to both platforms and flagged when it's someone's first
booking." Mo: "how do we add all of the tracking pixels etc can you do it yourself".

Shop events (product views, cart, checkout and purchases) are Shopify's channel apps' job: Facebook & Instagram, Google &
YouTube and TikTok, each in its own pixel and server-side too. None of them can see a booking or sign-up made through the
Lair, so the Lair says when one counts and the website tells the platforms.

## 1. `track` on a booking's answer

The answers of `POST /proxy/bookings` (a table or a TTRPG seat), `/proxy/events/:id/join` (a sign-up),
`/proxy/events/:id/reserve` (a game spot) and `/proxy/games/:id/join-series` (a weekly seat) add `track` when the ad
platforms should hear about it (`bookedTrack` in `src/newplayers.js`):

```
track: { id, kind, value, currency, first }
```

- `id`: its code (the booking's or sign-up's ref; for a weekly seat, the seat it saved). Each platform counts an ID once.
- `kind`: `table`, `ttrpg`, `event`, `game-spot` or `weekly`.
- `value`: what it comes to, in dollars (its amount; 0 for something free). `currency`: `CURRENCY` (NZD).
- `first`: whether it's their first booking at Dice Goblin: no session at the Lair before (round 24's `playedBefore`: a
  visit, a named or guest place, or a counter purchase) and no other booking or sign-up of theirs that wasn't cancelled.
  null without an account (a TTRPG seat booked as a guest).

Only a **confirmed** one is told. Left out: one held for online payment (its checkout's purchase is counted by the
channel apps), what staff make for someone (the staff page's bookings and walk-ins), and joining a weekly game when the
next seat was already theirs or isn't on the board yet. An answer without `track` is as it was.

## 2. The website (theme)

- `assets/lair-core.js`: a successful POST to one of those routes whose answer has `track` announces it to the page as a
  `lair:booked` event. Demo mode doesn't go through the Lair app, so the lab's made-up bookings are never told.
- `assets/tracking.js` (loaded only when an ID is set in Theme settings › Ad tracking) sends each booking once:
  - Meta: `fbq('trackSingle', pixel, 'Schedule', { value, currency, content_category: kind, first_booking }, { eventID: 'booked-<id>' })`, with the pixel's automatic events off and no page view;
  - Google Ads: the "Booked a session" conversion (`send_to: AW-…/<label>`, `transaction_id: <id>`), and "First booking"
    too (`transaction_id: first-<id>`) when it's someone's first and that label is set;
  - TikTok: `track('Schedule', { value, currency, … }, { event_id: 'booked-<id>' })` on the pixel's own instance;
  - Shopify's analytics: `dice_goblin:booked`, for any pixel in Settings › Customer events that wants it.
- Nothing loads until there's something to send, apart from someone arriving from an ad: from a Google ad (gclid, gbraid
  or wbraid) Google's tag loads on that page without a page view, so it keeps the click; from a TikTok ad (ttclid),
  TikTok's pixel the same way; from a Facebook or Instagram ad (fbclid), the click goes in Meta's `_fbc` cookie
  (`fb.1.<ms>.<fbclid>`, 90 days) with no script.
- A visitor who has said no to marketing (`Shopify.customerPrivacy.marketingAllowed()` false) is told nothing and has no
  click kept.
- The browser check: `tools/qa/round28/booked.mjs` (the theme mock, live mode with a stand-in Lair app and the
  platforms' scripts stood in for).

## 3. Setting the IDs

Once the Facebook & Instagram, Google & YouTube and TikTok apps are installed, on the live theme, Theme settings › Ad
tracking:
- Meta pixel ID: the pixel the Facebook & Instagram app uses.
- Google Ads tag ID (`AW-…`) and the label of a Website conversion "Booked a session" (category Book appointment,
  counted once per click, its value from the tag); optionally a second, "First booking", for the bidding to aim at.
- TikTok pixel ID: the pixel the TikTok app made.

Empty switches that platform off.

## 4. Known limits

- Browser only for now. Ad blockers and some browsers stop some events; server-side sending (Meta's Conversions API,
  TikTok's Events API) with the same event IDs can come later and would be counted once with these.
- No customer details are sent (no advanced matching or enhanced conversions). That needs Mo's yes first.
- TikTok keeps its click in its own cookie when its pixel loads on the landing page. When TikTok ads start, check in
  TikTok's Events Manager that Schedule events are matched to clicks.

## 5. Going live

The Lair app first (today's theme ignores `track`), then the theme: lab, preview, live, each with Mo's yes. Then the IDs
in Theme settings on the live theme.

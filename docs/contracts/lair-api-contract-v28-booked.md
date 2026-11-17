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

- `id`: its own opaque ID (the booking's or sign-up's `id`; for a weekly seat, the seat it saved), never its code, which
  carries the booker's initials. Each platform counts an ID once.
- `kind`: `table`, `ttrpg`, `event`, `game-spot` or `weekly`.
- `value`: what it comes to, in dollars (its amount; 0 for something free). `currency`: `CURRENCY` (NZD).
- `first`: whether it's their first booking at Dice Goblin: no session at the Lair before (round 24's `playedBefore`: a
  visit, a named or guest place, or a counter purchase) and no other booking or sign-up of theirs that wasn't cancelled.
  Since 17 Nov 2026 (section 6) "theirs" is found by account, email and mobile, for guests too; null only with none of
  those.

Only a **confirmed** one is told. Left out: one held for online payment (its checkout's purchase is counted by the
channel apps), what staff make for someone (the staff page's bookings and walk-ins), and joining a weekly game when the
next seat was already theirs or isn't on the board yet. An answer without `track` is as it was.

## 2. The website (theme)

- `assets/lair-core.js`: a successful POST to one of those routes whose answer has `track` announces it to the page as a
  `lair:ad-booked` event. It has its own name because `assets/lair-booking.js` already fires `lair:booked` for the page
  (in demo mode too), and that one is never for the ad platforms. Demo mode doesn't go through the Lair app, and in demo
  mode (the lab) `layout/theme.liquid` doesn't load the IDs or `assets/tracking.js` at all.
- `assets/tracking.js` (loaded only when an ID is set in Theme settings › Ad tracking) sends each booking once:
  - Meta: `fbq('trackSingle', pixel, 'Schedule', { value, currency, content_category: kind, first_booking }, { eventID: 'booked-<id>' })`, with the pixel's automatic events off and no page view. `first_booking` is left out when `first` is null (a guest's booking is never told as a repeat);
  - Google Ads: the "Booked a session" conversion (`send_to: AW-…/<label>`, `transaction_id: <id>`), and "First booking"
    too (`transaction_id: first-<id>`) when it's someone's first and that label is set;
  - TikTok: `track('Schedule', { value, currency, … }, { event_id: 'booked-<id>' })` on the pixel's own instance;
  - Shopify's analytics: `dice_goblin:booked`, for any pixel in Settings › Customer events that wants it.
- Nothing loads until there's something to send, apart from someone arriving from an ad: from a Google ad (gclid, gbraid
  or wbraid) Google's tag loads on that page without a page view, so it keeps the click; from a TikTok ad (ttclid),
  TikTok's pixel the same way; from a Facebook or Instagram ad (fbclid), the click goes in Meta's `_fbc` cookie
  (`fb.1.<ms>.<fbclid>`, 90 days) with no script.
- A visitor who has said no to marketing (`Shopify.customerPrivacy.marketingAllowed()` false) is told nothing and has no
  click kept. The page asks Shopify for its privacy API (`Shopify.loadFeatures`, `consent-tracking-api`) and waits for it
  before keeping a click or sending a booking; if it can't be loaded, nothing is kept or sent.
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
- No customer details were sent until 17 Nov 2026; section 6 adds enhanced matching, with marketing consent only.
- TikTok keeps its click in its own cookie when its pixel loads on the landing page. When TikTok ads start, check in
  TikTok's Events Manager that Schedule events are matched to clicks.

## From the review

A separate review found no critical or high problems. Fixed, each with a browser check that failed first:
- (medium) a guest's booking (first unknown) was told to Meta as `first_booking: false`;
- the privacy check read Shopify's privacy API before it had loaded, so it said yes;
- demo mode (the lab) with IDs set still kept clicks from ad links;
- the event ID was the booking's code, which carries the booker's initials (now its opaque ID, a Lair change);
- the page event shared its name with `lair-booking.js`'s `lair:booked`.

## 5. Going live

The Lair app first (today's theme ignores `track`), then the theme: lab, preview, live, each with Mo's yes. Then the IDs
in Theme settings on the live theme.

## 6. 17 November 2026: first booking for everyone, paid clicks keep their credit, enhanced matching

From the website review before more ad spend (Google Search ads live since 16 Nov; Meta and TikTok next): the ads
couldn't tell a new player from a regular, an old unpaid link took the credit for a paid click, and the platforms got no
customer details to match bookings to the people who saw the ads.

**First booking for guests (Lair, `firstBooking` in `src/newplayers.js`).** `first` is worked out from the booking's
account and the email and mobile saved on it (any case; a mobile by its key, `phoneKeySql`, the same as `mobileKey`:
021 555 0100 and +64 21-555-0100 are one). Not first when the Lair knows them from before by any of those:
- a member with that account, email (or verified account email) or mobile (at most 5) with another booking or sign-up
  that wasn't cancelled, or who has been to the Lair (`playedBefore`, which takes in counter purchases at the till);
- another booking or sign-up that wasn't cancelled with that email or mobile on it, whoever made it;
- a named place by that email on someone else's booking that wasn't cancelled (round 11's game spot players).
What the same request made never counts. The answer is only `first: true | false` for this booking: nothing about who
matched. Lookups by mobile use the new expression indexes `bookings_phone_key`, `event_joins_phone_key` and
`members_mobile_key` (made on start). Someone could book with another person's email or mobile to learn whether the Lair
knows it; that costs a real, confirmed booking (a confirmation to that email, staff see it, at most 6 upcoming per email).

**Paid clicks keep their credit.** A member's first ad tags (round 24, what the weekly numbers credit a new player to)
give way once to a paid click (`isPaidAd`: utm_medium paid, cpc, ppc, cpm, cpv, paid-social and the like) while the member
hasn't been to the Lair yet. A booking's own tags are always its own. The website does the same with the link it keeps
(theme `assets/theme.js`): a paid click (utm_medium as above, or Google's gclid, gbraid or wbraid, or TikTok's ttclid)
replaces an unpaid one it kept, and the first paid click stays for its 30 days. Meta's fbclid alone is facebook/social,
because Facebook adds it to every link, paid or not: Meta ads carry `utm_medium=paid` in their URL parameters.

**The website's tags (theme `assets/tracking.js`).**
- First booking (`first: true`): Google Ads' "First booking" conversion (as before, once its label is set); Meta's and
  TikTok's standard `CompleteRegistration` (`booked-first-<id>` as the event ID), on top of `Schedule`. A standard event,
  because TikTok can't aim ad groups at custom events, Meta optimises standard events best, and neither the Shopify
  channel apps nor anything else on the site sends `CompleteRegistration`, so it means only "someone's first booking".
- Enhanced matching, only when marketing is allowed: the email and mobile from the booking form (or the logged-in
  customer's), normalised and SHA-256 hashed in the browser. Google: `gtag('set', 'user_data', { sha256_email_address,
  sha256_phone_number })` (gmail dots dropped, E.164 phone); Meta: `em` and `ph` on `fbq('init')` (digits with country
  code); TikTok: `identify({ email, phone_number })` (E.164). Plain text never leaves the page.

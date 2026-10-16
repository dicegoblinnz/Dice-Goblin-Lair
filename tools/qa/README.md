# QA tools (local only)

Nothing here ships. The Worker bundles only `src/`, and `npm test` runs only `test/*.test.js`.

## live: the real Worker with a fake Shopify

`DG_THEME=/path/to/theme sh tools/qa/live/run-all.sh` runs the whole thing from a clean slate, against that theme checkout. It needs `npm install` at the repo root first (for wrangler) and in `theme-mock` (for liquidjs). It takes about ten minutes, and the bookings it makes "today" need it to start before about 4pm Auckland time.

**What starts:**
- `fake-admin.mjs` on :8799 stands in for the Admin API, OAuth and Resend. It records every call in `fake-admin.calls.jsonl`.
- `wrangler dev` runs on :8787 with `dev/wrangler.toml`. Its entry, `dev/worker-entry.mjs`, sends every Shopify or Resend request to the fake and refuses anything else.
- Fake secrets come from `dev/dev.vars.example`, which `up.sh` copies to `dev/.dev.vars`. They include client secret `hush` and setup key `test-setup-key`.
- `down.sh` stops only what `up.sh` started (its saved pids and their children, and workerd from this checkout). `ONLY=wrangler` stops or starts just wrangler, so the fake keeps what it holds.
- Events come from `theme-mock/events-mock.mjs`: the store's events if `events-qa/events-data.json` is there, otherwise a stand-in set of weekly events, plus one-offs counted from today (tonight's D&D, and two Riftbound Sundays).

**What runs:**
- Seeds: `seed.mjs` and `seed-today.mjs`.
- POS routes: `pos-http.mjs`.
- Page flows, phone and desktop, driven by Playwright through `harness.mjs`.
- Round 5 (`flow-r5-*.mjs`): passes sold as a product (`LAIR-PASS-N` orders), birthday gifts, weekly regulars, the Members view, one bill at the POS (`/pos/checkin-member` with owed lines and the tab), and the staff page's owed rows with Waive, members list and gifts.
  - Weekly regulars need a session to have ended. `flow-r5-regulars-setup.mjs` books one, then `run-all.sh` stops wrangler and `r5-travel.py` moves that game a week earlier in the saved state, starts wrangler again, and `flow-r5-regulars.mjs` runs maintenance (`/setup`) and checks what's owed.
- Round 6 (`flow-r6-*.mjs`, HTTP only, no browser): the loyalty card (check-ins, stamps, rolls and their store credit, staff rolls, customer since, the POS view, birthdays), spend by month and financial year with the Shopify backfill, session gifts (`LAIR-GIFT-N` orders, the buyer's email, claiming), library holds, and guest seats (the GM's email, adoption on My Lair, a hold's `game`). `r6-time.mjs` works out Lair times and the words emails use.
  - A library hold has to run out of time: `flow-r6-holds.mjs` makes one, `r6-travel.py` moves its end into the past during the same wrangler restart as `r5-travel.py`, and `flow-r6-holds-expiry.mjs` checks maintenance expired it once and emailed the member.
  - `fake-admin.mjs` answers the round 6 queries too (`CustomerEmail`, `CustomersSince`, `VariantCopies`, `CustomerOrders`, `OrderGiftBuyer`). `POST /__fake/variant` sets a variant's stock. `POST /__fake/set` also takes `failVariant`, `failOrders` and `scopes` (add `read_all_orders`, say), and `failBuyer` fails `OrderGiftBuyer` too.
  - `flow-mylair.mjs`'s dice part checks the round 5 theme's spend roll gets the 410, then rolls loyalty rolls staff gave.
- Round 7, backend-b (`flow-r7-b.mjs`, HTTP only, right after `flow-r6-guests.mjs`): the customer picker, groups and a group's session pass (booking with it, the Wallet, check-in, the POS, claiming, archiving), the events editor (a picture through the staged upload the Worker posts itself, add, the sign-up date rule, update, delete, the 503 before `write_metaobjects` is approved), staff TTRPG sessions under the GM rules with a GM invited by email who then makes an account, and players staff add (a weekly regular, and a reserved weekly seat whose invite is taken up).
  - `fake-admin.mjs` answers `LairCustomers`, `LairEventsAdmin(Plain)`, `LairEventHandle`, `LairEventCreate/Update/Delete`, `LairStagedUpload` and `LairFileCreate`, checking values the way the `lair_event` definition does, and keeps what the editor writes, so the Lair's own rules (`LairData`) see it. `POST /__fake/set` takes `denyCustomers`, `denyEventRefs`, `denyEventWrites` and `denyFiles`; `GET /__fake/events` and `/__fake/uploads` show what it holds. The dev entry sends Shopify's staged upload host (`shopify-staged-uploads.storage.googleapis.com`) to the fake's `/__upload`.
  - The fake's checkout links use `QA_PORT` (4180 when it's not set), so a run on your own port lands on your own mock.
- Round 8, guests (`flow-r8-guests.mjs`, HTTP only, right after `flow-r7-b.mjs`): friends on event sign-ups. Ria signs up for tonight's D&D with Manu by his member code and Jo by name (customers 7801 to 7803): the 422s, the names the Lair keeps, the email's "Coming:" line (guests aren't emailed), staff's view of each guest, Manu's My Lair (`guestOf`, `canCancel: false`, no money), his 403 on cancelling, his member code at check-in finding the sign-up, and his own stamp (Ria gets hers and Jo's). `flow-events.mjs` adds the people after you with "Add another person" since round 8 (round 7's form had How many? chips).
- `live-smoke.mjs`.
- Round 11, reminders (`flow-r11-reminders.mjs`, HTTP only, right after `flow-r9-play.mjs`): "Remind me the day before" (opting in, the toggle, exactly one reminder each at a fixed time, never twice, never at night, a late opt-in that morning, each day of a two-day event its own), the calendar file at `/ics/<date>.ics`, and the waitlist for a full date (the staff's and the person's emails, counts for the public, names for staff). The dev entry's `POST /__dev/reminders { at }` runs the reminders at a fixed time through the Lair's internal route (the cron runs them at the real time), so the flow never moves the machine's clock.
- Round 7, backend-a (`flow-r7-a.mjs`, HTTP only, right after `flow-r6-gifts.mjs`): mobile numbers on bookings, sign-ups and game spots (none on staff bookings), the player profile and what a GM sees of it, loot codes and "Got a code?" (loot, pass and gift codes), the loyalty card's number, gifts in words and a gift's product code used on an order, holds until midnight, games at home, scanning to borrow (since 16 Oct 2026 a game at home scans as at-home and stays out, a member's "Back on the shelf" is a 403, and staff check it in at the counter), staff check-out and check-in, and the tab's barcode lookup. Shopify refusing the lookup comes last, because the Lair then waits 10 minutes before asking again (the flow checks that too).
  - `fake-admin.mjs` answers `LairVariantByCode` (variants from `POST /__fake/variant-code { id, productId, handle, productTitle, sku, barcode, price, libraryCode, productImage, … }`; `POST /__fake/set { failVariantCode: true }` refuses it like a store without `read_products`) and `LairGiftCodeUse` (the codes `Prize` made; `POST /__fake/discount-use { code, count }` sets how often one was used). `POST /__fake/order` takes `discountCodes`, and `OrderSpend` answers them with `processedAt`.
  - Every customer booking needs a mobile from round 7, so `client.mjs`'s `proxy()` adds `phone: '021 555 0100'` to a booking, join-series, event sign-up or game spot that sends none (`phone: undefined` leaves it out). The round 6 flows expect round 7's hold times (`r6-time.mjs` words them "midnight, …"), messages and loyalty (no welcome roll).
  - The page flows type a mobile wherever the form has a field for one.

**Paths and config:**
- `harness.mjs` and `fake-admin.mjs` render the theme from `DG_THEME`. Point it at a theme checkout.
- Playwright is required from `/opt/node-tools/node_modules/playwright`, which comes with the Claude cloud container. Change that path anywhere else.
- `dev/wrangler.toml` is named `dice-goblin-lair-qa`. Never deploy with it.

## theme-mock: render the theme without Shopify

`npm install` (liquidjs), then `DG_THEME=/path/to/theme node -e "import('./render.mjs').then(m=>m.serve(4173))"` (or `node render.mjs check` to render every route once).

The other scripts are screenshot and flow checks built on it.

**Gotcha:** inside `{% liquid %}`, a comment line that starts with punctuation or holds quotes or brackets breaks liquidjs. Real Shopify is fine with it, so rephrase the comment.

## round5: theme checks for the round 5 branches

These run the theme in demo mode through `theme-mock`, at phone size and then desktop.
- `mg4/`: My Lair and the games board. `sh final.sh` runs them all.
- `bk4/`: the staff page. `r4/` holds the round 4 staff scripts.

Set `DG_THEME` to the branch checkout. The defaults point at the old worktrees.

Late at night, bookings seeded "today" can land on tomorrow and trip date checks. The bk4 scripts take `LAIR_AT=…` to pin the page clock.

## theme-check

`npm install`, then `node run.mjs /path/to/theme`. A clean theme prints `counts {}`.

## sim: a real-data simulation (round 12)

`sim/sim.mjs` walks the website on the live stack with the store's own events and GM games, as a visitor, a member and
staff on a phone (390) and a desktop (1280), then changes things behind their backs (a game's picture taken away, a
session cancelled, an event deleted in Shopify) and looks again. It checks that the app and the theme agree (event
dates, repeat tags, seats), that maintenance tells staff things once, and that nothing breaks; it prints `ISSUE` and `ok`
lines, saves a screenshot of every page and sheet, and writes `findings.json`.

The store's data stays out of this public repo: `DG_SIM_EVENTS` is a JSON list of `lair_event` entries in
`theme-mock/events-mock.mjs`' QA_EVENTS shape (the mock and the fake read it, and it's the only events), and
`DG_SIM_GAMES` is the owner's `games.add` payload. Start the live stack with `DG_SIM_EVENTS` set, then run it under the
live lock with `DG_THEME`, `OUT` and `QA_PORT`. The dev entry's `POST /__dev/admin-job` and `POST /__dev/maintenance`
run an owner's job and the cron's maintenance at once.

## round13: the Our games page (round 13)

`round13/our-games.mjs` opens the theme's Our games page on the live stack with the store's events and GM games
(`DG_SIM_EVENTS`, `DG_SIM_GAMES`, as the simulation), as a visitor on a phone and a desktop: each game's tile (its night,
next dates, what's left, Follow), the TTRPG tile and Today at the Lair, every tile's first date opening its sheet in the
calendar, a session link opening its session, the Follow dialog's links, the calendar's "See all our games", and each
game's feed (`GET /feeds/<key>.ics`, public and through the signed proxy) holding the dates the page links to. Run it
under the live lock with `DG_THEME`, `OUT` and `QA_PORT`. The harness' stand-in proxy now passes the app's own content
type on, as Shopify's does.

## round14: the one booking page (round 14)

The Book a table, TTRPG sessions and Events calendar pages are one view now (Mo, 11 Oct): Show (Events, TTRPG games,
Free tables, in any mix), the map at a day and time with a sheet per table, everything on the day, Looking for players,
and Book. Round 9's tabs are gone, so `round9/play.mjs` and `round10/tables.mjs` (which drove them) are kept as they were,
for the record; these two take their place.
- `round14/one-page.mjs`: demo mode on the theme mock, phone then desktop: each page's own switch and heading, the
  address keeping the switches (`?show=`, the old `?tab=`, `?players=1`), the strip of days and the month, a day and a
  time, the map following the switches, a TTRPG game's sheet and joining it, a free table's sheet and booking it end to
  end (and Back, the browser's too), "I'm interested", an event sign-up with a guest, an event's table, "I'm coming"
  (one tap for a member), Looking for players, Run a game and hosting, old links (`#game=`, `#event=`, `?join=`),
  the keyboard, axe and no sideways scroll. `DG_THEME=… PORT=4953 [AXE=…/axe.min.js] [OUT=…] node tools/qa/round14/one-page.mjs [phone|desktop]`.
- `round14/one-page-live.mjs`: the live stack with the store's events and GM games (`DG_SIM_EVENTS`, `DG_SIM_GAMES`; the
  games move on to their next date still to come): each open day of the next week against the app (the calendar
  feed's event dates and the floor's TTRPG games in the list, the counts, the line above the map at the day's busiest
  hour), every game's table and sheet, every event's tables and sheet (two events on the same tables at once: the
  sheet's "Also on these tables"), Looking for players, and a free table booked end to end. Run it under the live lock.
- `round14/one-page-b.mjs` (round 14b, after an independent check against the approved mock-up): demo mode, the first
  screen at 320 to 414px (the intro just its heading on one line, no sideways scroll, See all our games under Run a game
  and Host your own event, side by side at 390px); a table's sheet on wide screens (1366x768, 1280x720, 1024x768, a
  tablet) opening in place, on screen under the header, as the short popover; on a phone the page dimmed behind it and
  Back closing it (then leaving the page), its X, its Join, Host your own event, a `#game=` link, a drag on its handle,
  a link elsewhere and Book, each leaving the history right; a game waiting for approval kept off the public map; How
  long (2, 3 or 4 hours, 3 first); `?show=none`; the seats badge's corner; events before games at the same time; the
  word spaces; the month's counts in Looking for players; the booking's map drawing events blue.
  `DG_THEME=… PORT=4955 [OUT=…] node tools/qa/round14/one-page-b.mjs`. The two above read the short popover too.
- `live/flow-booking.mjs` picks days on the strip or in the month; the simulation and `round11/reminders.mjs` read the
  page's new rows (`.play-row`, `.play-said`) and its note above the map. (Round 15: it books from a table's sheet on the
  map, below.)

## round15: everything on the tab, locked 24 hours before (round 15)

Mo (12 Oct): no new page to book a table, no QR code per booking or sign-up, everything on the person's tab, paid at the
counter on the day (or a few at once), and cancelled online only until 24 hours before; after that only staff take it off.
- `round15/signups.mjs`: demo mode on the theme mock, phone and desktop, a guest and a member: a TTRPG seat, event sign-ups
  (paid, inside 24 hours, free), an event's game table; the forms' lines about the tab and the lock, no paying online;
  the confirmations (no QR or code, the tab's words, until when to cancel or locked in, Add to calendar's file, My Lair or
  Make a free account); a member's own seat and sign-up with Cancel, and locked once the page clock moves inside 24
  hours. Axe on each sheet.
- `round15/mylair-staff.mjs` (with `lib.mjs` and `seed.mjs`): My Lair and the staff page in demo mode for Ruby (tables
  more than and less than 24 hours away, an owed no-show, a seat, sign-ups either side of the 24 hours, an owed sign-up):
  Cancel or locked in, no code per item, the tab card ("Pay at the counter: just give your name", Show my Goblin card),
  staff's owed sign-ups (Mark paid, Waive) and paying several at once on a member's page.
- `round15/demo.mjs`, `demo-b.mjs`, `demo-c.mjs`: the demo backend (`assets/lair-demo.js`) against the contract
  (`docs/contracts/lair-api-contract-v15-tab.md`), with a movable clock.
- Each takes `DG_THEME` (required), `PORT`, and where it says so `AXE` (a path to axe.min.js) and `OUT` (screenshots; the
  system's temp folder otherwise).
- The live flows follow round 15 too: `flow-booking.mjs` books from a table's sheet in the booking sheet over the page
  (no code or QR on the confirmation, a guest pays on the day by name); `flow-events.mjs` signs up for events sold online
  or in store with no checkout made (an older page sending `pay: 'now'` too, and with Shopify's checkout down); `flow-games.mjs`
  and `flow-mylair.mjs` read the tab's words and Cancel by (or locked in, whichever it is when the run happens);
  `flow-staff.mjs` has a sign-up paid at the counter ahead of time and cancelled in time as a refund due;
  `flow-r5-regulars.mjs` has the one-off seat owed once it's over unpaid (no-show or not) and the Members view counting
  it; the email checks read the round 15 words. Flows that tidy up a booking or sign-up inside 24 hours cancel it as
  staff, since its owner no longer can.
- The live run is best started in the morning: `seed-today.mjs` books for 5pm today (too soon to book online after about
  4pm), and tonight's 6pm D&D only earns loyalty stamps when the run started before it.

## Library returns: staff put games back on the shelf (16 Oct 2026)

Mo (16 Oct): members only scan games to borrow them; staff scan games back onto the shelf (contract
`docs/contracts/lair-api-contract-v16-library-returns.md`).
- `live/flow-r7-a.mjs` (HTTP, the local stack): Hone's second scan of Azul (and one with `action: 'return'`) is `at-home`
  and his loan stays out, his own "Back on the shelf" (`POST /library/loans/:id/return`) and Mereana's are 403s with the
  words, and staff check Azul in at the counter (`POST /library/return`); the tidy-up at the end is a staff check-in too.
- `round7/library.mjs` (demo mode on the theme mock): Kiri's scan of a game at home says to bring it to the counter (an
  answer, not an error) and it stays in My Library, which has no button to put it back and no "scan it again" hint;
  staff check it in on the Library tab, then it's off My Library; the game page doesn't say to scan it to return it.
  These checks need the theme's demo backend (`assets/lair-demo.js`) and words to follow the contract; until they do,
  they fail.

## round16: the game page (round 16)

Mo (16 Oct): a summary of the game under the title, markers (players, play time, age, difficulty and type), stock and
delivery (ships within 3 working days), Order as a gift (a message, no prices), Try it first when the library has it,
games only, and the wishlist built but switched off.
- `round16/game-page.mjs`: the theme mock, phone and desktop. Catan (Try it first by the -library handle rule) in order:
  title, summary, markers, price, stock and delivery, buy, gift, Try it first, About the game; Read more lands on About;
  Order as a gift (fields off until opened, the add's Gift, Gift for and Gift message properties with the empty one left
  out, the cart's gift line, closed and emptied once added, a plain add after it); 7 Wonders Duel's pair by metafield;
  Only 2 left (Cascadia), sold out (Sushi Go Party!), not tracked and custom.brief (Heat), two editions that swap the box
  (Everdell); library copies' Want your own? and markers (Paladins' age from its stats line); paint, an RPG book and the
  membership in their plain layouts; the wishlist (demo, live against a stubbed Lair app, logged out). Axe, no sideways
  scroll. `DG_THEME=… PORT=4975 [AXE=…/axe.min.js] [OUT=…] node tools/qa/round16/game-page.mjs [phone|desktop]`.
- The theme mock's round 16 data (`theme-mock/render.mjs`, `r16`): product types, descriptions laid out like the
  shop's write-ups, custom.difficulty, type tags, and the pairs (`catan` and `catan-library`, `7-wonders-duel` with
  `7-wonders-duel-library`); `all_products` for Liquid, `requires_shipping` on variants, and multipart cart adds with
  their line item properties.
- `round16/library-numbers.mjs`: Mo (16 Oct) asked for the site to say exactly what the library has, not "500+ games".
  The theme counts it live (`snippets/library-numbers.liquid`: `[games]`, `[rpg_books]` and `[library]` in copy). On
  the theme mock with the store's counts that day (681 in the library collection with the membership, 136 in the
  automated Library RPG books collection, so 544 games and 136 RPG books): no vague count left in the theme's copy, the
  Library theme settings, and each place that said 500+ (hero fact, announcement bar switched on in a copy of the
  theme, library and membership pages, the bookings page's answer and its FAQ structured data, the library
  collection's count, See all, My Library's invite), then the numbers following a change in the store. Phone and
  desktop. `DG_THEME=… [PORT=4976] [OUT=…] node tools/qa/round16/library-numbers.mjs [phone|desktop]`. The mock's
  library collection holds the store's count and its copies know their collections (`library-rpg-books` for the RPG
  shelf), which round 9's site check reads for the hero's games fact.
- `round16/library-lending.mjs`: Mo (16 Oct) asked for staff to lend a game to anyone, with no account or plan and
  nothing to pay (contract `docs/contracts/lair-api-contract-v16-library-lending.md`). Demo mode on the theme mock, phone
  and desktop: the staff desk's Lend to someone new (the name, then an email or mobile, each said and focused, a
  landline in the Lair app's words), lending by typing and with the camera, an email that's a member's, Pick a member
  instead, a member with no plan (lent, no notice), a plan member (checked out), a search with no match offering to
  lend, Games at home marking Lent and a guest's email and mobile, and a guest's game checked in. Then the person logs
  in with that email: the game is theirs, My Library shows it lent and free with no invite to join on top, and My
  Lair's Library tile says "1 game lent to you"; a plan member's lent game doesn't use the plan. `DG_THEME=…
  [PORT=4986] node tools/qa/round16/library-lending.mjs [phone|desktop]`.
- `round16/library-lending-axe.mjs`: axe on the lend form, Games at home with lent games, the no-match search and My
  Library (lent only, and a plan with a lent game), and the keyboard through Lend to someone new (Enter moves Name →
  Email → Mobile → the game). `DG_THEME=… AXE=…/axe.min.js [PORT=4988] node tools/qa/round16/library-lending-axe.mjs`.

## round17: GM credit for staff (round 17)

Mo (16 Oct): staff he pays to run GM games don't get the $5-a-player GM credit, with a toggle, or none during their
hours (contract `docs/contracts/lair-api-contract-v17-staff-gm-credit.md`). Players pay the same.
- `test/round17-staff-gm-credit.test.js` (npm test): the words, cleaning and saying hours, a session in someone's hours
  (even partly, across midnight and daylight saving), `GET /team`'s `gmCredit` and hours, `POST /team/gm-credit` and
  `POST /team/:id/hours` (the main account only), `POST /games/:id/credit` in each setting (Never; in and outside their
  hours; `onShift` both ways; Always; a $0 fee; the main account as GM; a removed helper), the floor's `staffGm` and
  `credit`, `GET /me`'s `staffGmCredit`, and the GM emails' "Your credit" line.
- `round17/staff-gm-credit.mjs`: the theme mock in demo mode, phone and desktop. The Team tab's GM credit for staff (Never
  ticked to start, each choice's words, saved as Not in their hours) and Ana's Hours (add, save, a bad time's words,
  Cancel); the GM games tab's card for her session yesterday in each state and what each button records; the GM page's
  "You get" for a staff GM; then live, the three calls against a stubbed Lair app. Axe, no sideways scroll.
  `DG_THEME=… PORT=4985 [AXE=…/axe.min.js] [OUT=…] node tools/qa/round17/staff-gm-credit.mjs [phone|desktop]`.

## round18: more for GM sessions (round 18)

Mo (16 Oct): staff GMs see each player in their own session, reserve seats (some kept for new players) and take players
off; staff make a session free; staff change a session's GM after it was set (contract
`docs/contracts/lair-api-contract-v18-gm-sessions.md`).
- `test/round18-gm-sessions.test.js` (npm test): who can set seats for new players (staff with GM games, the session's GM
  when they're on the team, nobody else) and their checks; online, only someone new takes a kept seat (by account or by
  email; new until they've played), their seats fill the kept ones, and one cancelled goes back to being kept; a weekly
  regular who isn't new leaves the kept seats, a new one has one at their first session only, and a released seat goes
  to the regular waiting; staff and the session's staff GM seat anyone (newPlayer said or worked out) and the GM isn't
  emailed about their own add; the floor's roster (who sees it, its fields, no emails); removing a player (who can, the
  refund flagged when they'd paid, before and once it's started); free (who can, the paid-seat 409, $0 seats and nothing
  owed, a staff edit keeps $0, no GM credit, the price back for sessions to come, a series from a session on and the
  sessions made later, and the board's series.free for a series' sessions to come); the GM emails' credit line for a
  free session; a new GM (a customer, a member's email, an invite that joins their account, a series from a session on,
  a credited session keeps its GM, both GMs emailed).
- `round18/gm-sessions.mjs`: the theme mock in demo mode, phone and desktop. The staff page's GM games manager (Free,
  new players and the GM: Seats for new players, Make it free and Charge again with the paid-seat refusal, Change the GM
  by email, the New player badge and tick in Add players); the GM page for Tama, a helper with Library only, in his own
  session (the roster, Seats for new players, Reserve a seat with its email check, Take a player off) and no roster in a
  session he doesn't run; for Ruby, who's played before, the last seat kept for new players with no Join; for Lee, who's
  new, a free session's card, details and join form; then live, the four calls against a stubbed Lair app. From the
  independent review: Make it free with Change the GM open, the new GM's name following the person picked, a seat booked
  free that stays free when it's charged for again inside the 24 hours, a free session's Session done, focus after
  running a session, the Reserve email's hint, a player taken off already, and no roster logged out. Axe, no sideways
  scroll. `DG_THEME=… PORT=4991 [AXE=…/axe.min.js] [OUT=…] node tools/qa/round18/gm-sessions.mjs [phone|desktop]`.

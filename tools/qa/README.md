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
- Round 7, backend-a (`flow-r7-a.mjs`, HTTP only, right after `flow-r6-gifts.mjs`): mobile numbers on bookings, sign-ups and game spots (none on staff bookings), the player profile and what a GM sees of it, loot codes and "Got a code?" (loot, pass and gift codes), the loyalty card's number, gifts in words and a gift's product code used on an order, holds until midnight, games at home, scanning to borrow and return, staff check-out and check-in, and the tab's barcode lookup. Shopify refusing the lookup comes last, because the Lair then waits 10 minutes before asking again (the flow checks that too).
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

## round10/memberships.mjs: the library memberships, theme side

`DG_THEME=/path/to/theme QA_PORT=4951 [AXE=…/axe.min.js] node tools/qa/round10/memberships.mjs [phone|desktop]`. Demo
mode through `theme-mock`, phone then desktop. It gives the mock's membership product the Lair's plans (one group,
Grab, Stash and Hoard, listed Stash first so matching by name is what's checked), then covers the join form and its
terms, My Lair's membership and damage charges in every state (the demo's `?membership=` puts the logged-in customer in
one), a library game's Reserve for a Lair member with no tags, and the staff page's Memberships and Damage tabs, the
member page and the Library tab's "Damage charge". A card payment taken now waits about 13 seconds for the demo's
pretend webhook. Contract: `docs/contracts/lair-api-contract-v10-memberships.md`, section 6.

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

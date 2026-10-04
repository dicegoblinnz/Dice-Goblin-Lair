# Dice Goblin Lair: booking app

The part of the website that remembers bookings. The Shopify theme shows the floor map, the booking form,
the GM games board, My Lair and the staff page; this app stores every booking, game, event sign-up, member,
session pass and self-serve tab, stops double bookings, takes payment through Shopify (at the POS, or online for
events that ask for it), keeps weekly regulars' seats, makes the session passes people buy, pays GMs their store
credit, rolls the dice prizes and gives the birthday gifts staff pick.

## How it fits together

```
www.dicegoblin.nz/apps/liar/...   (the booking pages call this)
        │  Shopify's app proxy signs every request and says who is logged in
        ▼
Cloudflare Worker  dice-goblin-lair  (src/index.js: checks the signature)
        ▼
One Durable Object with a small SQLite database  (src/lair.js: bookings, games, holds, credits)
        │
        ├── Shopify Admin API: rooms and events (metaobjects), booking rules (theme settings),
        │   customer tags (staff, gm), checkouts for events paid online (draft orders), store credit, birthday gift codes
        ├── Shopify webhook orders/paid → records payments for bookings and sign-ups (online or POS, a bill can be
        │   paid in parts), makes session passes bought as a product, marks tabs paid, adds to members' spend
        └── Resend → every email, as HTML with a plain-text copy

Shopify POS (counter iPad) → POS extension → /pos/today, /pos/scan, /pos/checkin, … (POS session token)
```

- Rooms come from **Content → Metaobjects → Lair rooms**, events that hold tables from **Lair events**.
- Prices, opening hours, lead time and the other rules come from the theme: **Customize → Theme settings → Lair bookings**.
- The app re-reads those every 5 minutes, so changes in Shopify show up on their own.
- Staff and trusted GMs are Shopify customers tagged `staff` or `gm`.

## Where things live

- **Code:** GitHub, `dicegoblinnz/Dice-Goblin-Lair`. Every push to `main` is built and deployed by Cloudflare Workers Builds (the Worker is `dice-goblin-lair` on the dicegoblinnz Cloudflare account).
- **Theme:** GitHub, `dicegoblinnz/Dice-Goblin-website`, branch `dice-goblin-2-theme` (connect it in Shopify: Online Store → Themes → Add theme → Connect from GitHub).
- **Address:** `https://dice-goblin-lair.dicegoblinnz.workers.dev`. Open it for a plain status page; the website reaches the app through `www.dicegoblin.nz/apps/liar`.
- **Keys and settings:** the D1 database `dice-goblin-lair-config`, table `config` (Cloudflare → Storage & databases → D1). Changes there apply within a minute, no redeploy needed. A Worker variable or secret with the same name overrides the database.
- **Health:** the same database's `status` table. Every 10 minutes the app checks its Shopify login, permissions, payment webhook, rooms and hours and writes the result there (`connection`, `rules`, `proxy`, `lastError`).

| Config key | What it is |
| --- | --- |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | the Shopify app's credentials (Dev Dashboard → app → Settings) |
| `SETUP_KEY` | key for `/setup?key=…`, which re-runs the health check and the payment webhook set-up on demand |
| `THEME_ID` | the preview theme to read the booking settings from until the new theme is published. Once the live theme has the booking settings the app uses it by itself; the `rules` row in `status` names the theme it read |
| `RESEND_API_KEY`, `FROM_EMAIL`, `REPLY_TO`, `STAFF_EMAIL` | booking emails through Resend (optional) |

## Set up

### 1. Cloudflare (done)

The Worker is connected to the GitHub repository and the keys are in the config database. If you ever start again from scratch: create the Worker by importing this repository (Workers & Pages → Create → Import a repository), keep the name `dice-goblin-lair`, and create the D1 database with the `config` and `status` tables (see `src/config.js`).

### 2. Create the Shopify app

1. Go to dev.shopify.com → **Apps → Create app**. Call it `Dice Goblin Lair`.
2. Create a version with:
   - **App URL:** `https://dice-goblin-lair.dicegoblinnz.workers.dev`. Embedding in the Shopify admin: off.
   - **Access scopes:**
     `read_customers, read_metaobjects, read_themes, read_orders, write_draft_orders, write_store_credit_account_transactions, write_discounts, write_app_proxy`
     (`write_discounts` makes the codes for birthday gifts from the shop; without it staff give those at the counter instead)
   - **App proxy:** prefix `apps`, subpath `liar` (`liar`, not `lair`: it's the live address and the theme calls it, so keep it), URL `https://dice-goblin-lair.dicegoblinnz.workers.dev/proxy`
3. Release the version, then **install** the app on the Dice Goblin store.
4. If Shopify asks about protected customer data, request it with the reason "store management". The app reads customer tags and, for members' spend, which customer paid an order and its subtotal. For a session pass bought by someone who isn't a member yet, it also reads the customer's name and email on that order (or the billing name when there's no customer on the sale), so request the **Name** and **Email** fields too. Without them the pass is still made: linked to the customer's account, or as "Sold at the counter" when there's no customer. It doesn't read phone numbers or street addresses.
5. The app's **Client ID** and **Client secret** (app → Settings) go in the config table as `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (already done for the current app).

### 3. Check the connection

Open `https://dice-goblin-lair.dicegoblinnz.workers.dev`. Within 10 minutes of the app being installed all four lines should be ticked:

- **Connected to the Shopify store:** the app can log in and has every permission it needs. If not, the `connection` row in the `status` table says why (wrong client ID or secret, app not installed, or `missingScopes`).
- **Online payments are reported back:** Shopify will tell the app when someone pays online.
- **The website has reached the app:** shows after the first visit to a booking page in live mode once the app proxy is set up. To check the proxy by hand, open `www.dicegoblin.nz/apps/liar/floor`: a page of text starting with `{` means it works; the shop's "page not found" means Shopify isn't passing the address on yet.

### 4. Emails (optional)

Booking emails go through [Resend](https://resend.com); the free plan (3,000 emails a month, 100 a day) is plenty. Add the domain `dicegoblin.nz` in Resend, add the DNS records it shows at Crazy Domains (where dicegoblin.nz's DNS is managed), create an API key, and put it in the config table as `RESEND_API_KEY` with `FROM_EMAIL` = `Dice Goblin <bookings@dicegoblin.nz>`, `REPLY_TO` = the shop inbox and `STAFF_EMAIL` = whoever should get approval and refund alerts. To check it works, open `/setup?key=YOUR_SETUP_KEY&email=test`: it sends a test email to `STAFF_EMAIL` and shows Resend's answer under `emailTest`. The status page also shows a line for booking emails, and the `email` row in the `status` table keeps the last result.

### 5. Tag staff and GMs

**Shopify admin → Customers →** open the person **→ Tags:**

- `staff`: can use the staff floor page. They log in to the website with that customer account.
- `gm`: a trusted GM whose games go on the board without waiting for approval.

New tags take up to 5 minutes to count.

### 6. Switch the booking pages to live

**Online Store → Themes → Dice Goblin 2.0 → Customize → Theme settings → Lair bookings:**

- **Booking system:** Live
- **Lair app address:** `/apps/liar`

Tables, walk-ins and GM seats are always paid at the counter (the old "Let people pay online" setting no longer does
anything). Events say for themselves how they're paid (see Day to day).

Then test on the theme preview: book a table and check in at the counter, sign up for an event paid online with a real
card (refund it afterwards), and check both show up on the staff page.

### 7. The POS extension

The POS extension on the counter iPad talks to the Worker directly (`https://dice-goblin-lair.dicegoblinnz.workers.dev/pos/…`),
with `Authorization: Bearer <POS session token>` (from `shopify.session.getSessionToken()`). The token is checked with the
same client ID and secret as everything else, so there's nothing else to set up. It shows today's roster, scans codes,
checks people in and puts what's left to pay in the cart as custom sales with the code in a `_booking` property (a
self-serve tab's items carry `_tab`). When that POS order is paid, the booking's payment is recorded and the tab is paid.

## Day to day

- **Rooms and tables:** Content → Metaobjects → Lair rooms (number of tables, seats per table, price per person, bookable online or not).
- **Events:** Content → Metaobjects → Lair events.
  - "Tables reserved" (`T14-T21`, `Gaming room` or `all`) marks tables for the event on the booking page, but anyone can still book them. Tick "Lock these tables" for special events: then nobody but staff can book them during the event.
  - "Payment": "In store" (or empty) is paid at the counter; "Online" always goes through checkout (if Shopify checkout is down, people are asked to call); "Online or in store" lets people choose. With no "Entry fee" (NZD a person), nobody pays.
  - "Game tables" (like `T14+T15, T16+T17`) lists the game spots people can book for that event; those tables are marked for the event too.
- **Quick holds** (a market, an impromptu tournament): staff page → Hold tables. These always block.
- **Codes:** every booking, seat, sign-up, member and pass has a code like `SJ-OWLBEAR-17`: the person's initials, a word and a number. Type it any way (`sj owlbear 17` works) or scan its QR. The first release's `GOB-7K2QXM` codes still work.
- **Online payments** (events only) show up in Orders, tagged `lair-booking`, with the code. Paid online is locked in: if the person cancels, the place is freed and it's flagged "Refund?" for you to decide. Refund in Shopify as usual, then mark it refunded on the staff page.
- **Refunds to make** are flagged: "refund due" (staff or the GM cancelled, so the money goes back) or "Refund?" (a paid no-show, or someone cancelled what they paid online: your call). `STAFF_EMAIL` gets an email, and a list when a GM cancels a game with paid seats.
- **Split bills:** people can tick "Split the bill at the counter" when they book. At the counter, each friend pays a share (the POS offers a share a person or any amount); scan the friend's member code first so their spend counts for them. The booking shows what's paid and what's left.
- **Session passes** ("Warhammer league: 10 sessions", "Gift pack: 10 sessions"): staff page → Passes. Each session covers one person's table fee (up to the table price; the $15 room still pays $5 and GM seats still pay the GM fee). Sessions are used when people check in, never when they book, so a no-show doesn't burn one. A used session can be undone.
  - **Selling passes:** sell the "Session pass" product (5 or 10 sessions; SKUs `LAIR-PASS-5` and `LAIR-PASS-10`) at the counter or online like anything else. When the order is paid, the app makes the pass ("Session pass: 10 sessions") on the customer's account, one for each one bought. With no customer on the sale, the pass carries the name on the order, or "Sold at the counter": give them its code (Passes lists it) and they add it in My Lair. A new size is just a new variant with the SKU `LAIR-PASS-` and the number of sessions.
- **Weekly regulars** ("join every session"): a regular always has a seat in the next session of their game. When a session ends, the app books each regular into the next one within 10 minutes, first to join first. Other players only see the seats left after the regulars. If the next session is full, `STAFF_EMAIL` gets an alert; if a seat frees up later, the regular gets it and an email. A regular's ticket is their member code.
  - **Owed sessions:** a regular's seat is theirs to pay for, whether or not they came. Once the session ends unpaid it's owed: it shows in their My Lair, at the counter when you scan their member code, and on the staff page under Members. They pay it at any visit. If you're letting it go, open the booking on the staff page and waive it. Ordinary bookings never become owed (a no-show is only recorded), and nor do seats booked before this update went live.
- **One bill at the counter:** scan a member's code on the POS and tap "Add everything to cart": it checks in today's sessions and puts them, anything they owe from earlier sessions and their self-serve tab in the cart, with them as the customer.
- **GM store credit:** after the session, staff page → the game → Credit GM. It counts players marked as paid, and Shopify emails the GM about the credit.
- If someone pays after their 30-minute hold ran out and their place was taken in the meantime, it's flagged "refund or reseat" (and `STAFF_EMAIL` gets an alert). Anything paid twice, or paid more than was owed, is flagged too.
- **Members:** anyone who books or opens My Lair while logged in. Each gets a member code the first time, which stays theirs; staff can give them a new one (the old one stops working). Staff search members by name, email or code, or list the top 100 by spend, by last seen or by what they owe (owed sessions plus unpaid tabs), or just those owing. Their spend counts every paid order with their customer on it, online or at the POS (scan their member code to attach them to the POS cart).
- **Self-serve tab:** members add drinks and snacks in My Lair. At the counter, scan their member code and the tab's items go in the cart.
- **Birthdays:** every day after 9am, `STAFF_EMAIL` gets the list of members with a birthday in the next week, each with a suggested gift (2% to 5% of what they spent in the last 12 months, at least $2) and whether they've had one this year. Nothing goes to members by itself any more. Give a gift on the staff page under Members: any mix of store credit, a session pass, extra dice rolls and something from the shop (a code just for them that makes it free, once, for 30 days). Tick the email box and Gobgob sends a "Happy birthday" email listing the lot. Anything Shopify couldn't do (store credit or the code) is listed straight away so you can sort it at the counter; the rest still goes through.
- **Game pictures:** GMs add their own; staff can add or change the picture on any game.
- **Dice prizes Shopify couldn't add** (store credit) come to `STAFF_EMAIL`; the member shows their screen at the counter, and the staff page lists them under the member until you mark them done.

## The rules the app enforces

**Tables**

- Bookings are in one-hour blocks, start on the hour and stay inside opening hours. Longest booking, booking lead time and how far ahead people can book come from the theme settings (defaults: 8 hours, 1 hour, 60 days).
- Nothing inside the lead time: at 1pm the first slot you can book is 2pm. Walk-ins are for anything sooner.
- Table fee is per person for the whole day: $10 everywhere except the Fancy room, which is $15. All tables in a booking are in one room, and everyone has to fit at them.
- The Fancy room is one big table for up to 12, booked by groups of 4 or more (a room's minimum is the "Minimum people" field on its Lair rooms entry).
- Opening hours come from the theme setting: weekdays 4pm to midnight, Saturday 10am to midnight, Sunday 10am to 10pm.
- Tables allowed = enough to seat the group (4 to a table), doubled for a wargame or big box game. Online bookings are for up to 24 people; bigger groups call the shop.
- The public booking page applies these rules to everyone, staff included. The staff page skips them by sending `staffOverride: true`, and walk-ins (staff only) can take any tables. Bookings made that way aren't linked to the staff member's own account.
- Tables, walk-ins, GM seats and "join every session" are paid at the counter: you reserve, it's locked in, and you pay when you arrive. (Tables the first release took online payment for keep its rule: refunded if cancelled at least 24 hours ahead, theme setting "Refund cut-off".) A no-show is only recorded; if they'd paid, it gets a "Refund?" note for staff to decide. Weekly regulars are the exception: a seat they keep is owed once the session ends unpaid (see GM games).
- A table can't be double-booked; bookings, staff holds and events that lock their tables count. An event's other tables are only marked for it.
- Codes look like `SJ-OWLBEAR-17`: initials from the first and last words of the name (accents dropped; one word gives its first two letters; `DG` with no letters), a word from a fixed list, and a d20 roll (21 to 99 once the d20 numbers are taken). One table keeps every code ever given out, so none is used twice across bookings, sign-ups, members and passes. Matching ignores case, spaces, dashes, dots and underscores. Check-in also takes the first release's `GOB-7K2QXM` codes.
- Split bills: `paidAmount` is what's been paid so far and `due` what's left after passes and payments. Each order line counts once, whoever pays it.

**GM games**

- 2 to 8 player seats; the GM isn't counted, so the players must fit at the tables (a GM can always take up to 2 tables, more for big groups). Seats cost the room's table fee plus the GM fee: $0, $5 or $10, and no fee needs a manager's OK.
- Staff and trusted GMs (tagged `gm`) go straight on the board; anyone else waits for a manager's OK.
- Joining a game needs a login. One booking takes 1 up to the seats left (at most 8), with a name for every seat.
- "Join every session" makes a weekly regular. It books a seat in the series' next session that hasn't started, and only that one. After a session ends, the 10-minute maintenance books each regular (first to join first) into the next session that hasn't started, if it's open and has room; a regular who already has a seat there, or cancelled it to skip that week, is left alone. If it's full, `STAFF_EMAIL` gets one alert per session and regular, and a seat that frees up later goes to them with an email. Regulars pay at the counter each time, skip one by cancelling that seat, or leave the series. Regulars who had seats in several future sessions before this rule keep them.
- Regulars' seats are held: for a session that hasn't started, the seats left for everyone else are the seats, less those booked, less the regulars with no booking in that session yet. A session that's under way holds nothing.
- The public games board shows only a series' next session that hasn't ended; GMs, staff and the game's own views see every session.
- A regular's seat whose session has ended unpaid is owed, whether or not they came: `owed` with `due` still due, in `dueNow` in My Lair, in the POS member view ("Owed: <title> (<date>)") and in the staff Members list. It's paid like any other booking line, at any later visit. Staff can waive it (`waived`), which makes `due` 0. Seats booked before round 5 went live never become owed, and one-off seats keep the no-show rule.
- A GM can cancel a session until an hour after it starts, or every future session at once. Every player gets an email, and seats that were paid for are flagged "refund due" (a cancelled game is always refunded). A player dropping their seat emails the GM.
- GMs (and staff) can email their players: one session's, or a whole series'. 5 messages a game a day; replies go to the GM.
- Store credit (the GM fee per paying player) is paid once, after the game starts. Moving or extending a game on the staff page moves its players with it; editing a game changes this session and the later ones of its series.

**Members, dice and birthdays**

- The home page dice are just for fun. Members earn a roll for every $20 they spend; rolls stack and never expire. Each "1" on the face is $1 store credit (1, 10 and 12–19 are $1, 11 is $2) and a natural 20 is $20. No discount codes. A roll is used up before Shopify is asked for the credit, so two taps can't spend it twice. Rolls given as a birthday gift add to the rolls available and never expire either.
- Session passes: one session covers one person's table fee up to the pass's cover. Sessions used = the people not covered or paid yet, up to the sessions left. A void or expired pass is skipped with a notice. Members use their own passes when they book; staff can use any. Every pass says where it came from: `staff` (made on the staff page), `order` (bought, with the order's name, like #1550) or `birthday`.
- Passes bought on an order: each paid line with the SKU `LAIR-PASS-<n>` makes one pass of n sessions for each unit (up to 100 a line), covering the table fee, with `pricePaid` the unit's price after the line's discounts. Each order, line and unit makes its pass once, however often Shopify sends the order. Passes with no customer can be claimed by code in My Lair.
- Spend is each paid order's subtotal after discounts, counted once per order. There's no clawback for refunds.
- Birthday gifts are chosen by staff; the app no longer makes birthday codes by itself (codes sent before still work until they expire). The suggestion is 2% and 5% of the last 12 months' spend, rounded to the dollar, at least $2 each. Store credit goes up to $1000; sessions and rolls are 1 to 20. A product gift is a one-use code for that one product variant, 100% off, only for that customer, for 30 days, named `HBD-` and their member code (then `-2`, `-3`…). The gift, its pass and its rolls are saved before Shopify is asked for the credit and the code, and what Shopify couldn't do is kept with the gift as `problems`.

**Events**

- Events with a capacity take sign-ups. An entry fee is paid the way the event's "Payment" says: at the counter, online (the spaces are held for 30 minutes until it's paid), or either.
- An event's "Game tables" (`T14+T15, T16+T17`) are game spots for 1 or 2 people: the first free one is booked as a wargame table for the event's time, at the entry fee a person (the table fee if there's none), paid the same way. Those tables stay bookable through the booking page.

**Payments and safety**

- An online payment only counts when it comes through that booking's own Shopify checkout. Paying an ordinary shop order with a booking number in the note does nothing. POS orders are made by staff, so a POS line with a `_booking` property pays its price times quantity, less its discounts, towards that booking (and a `_tab` line pays that tab).
- Staff can do anything at any time; the time rules don't apply to them on the staff page.
- Some light abuse limits for everyone else: at most 6 upcoming bookings per email address (seats from "join every session" don't count), and a cap on how many bookings one connection can make in 10 minutes.
- The public floor never shows names or emails. Staff holds show as "Tournament", "Market", "Event", "Out of action" or "Reserved", never the note staff typed.

## If something isn't working

- **Status page says "Waiting for the store link".** Shopify admin → Settings → Apps → Dice Goblin Lair should list an app proxy at `www.dicegoblin.nz/apps/liar`. If there's none, add it to a new app version in the Dev Dashboard (prefix `apps`, subpath `liar`, URL `https://dice-goblin-lair.dicegoblinnz.workers.dev/proxy`) and release it. If the store shows a different address, use **Customize URL** there to set `apps` / `liar`, or change the theme setting **Lair app address** to match.
- **Bookings say "The booking app only accepts JSON requests."** Shopify has stopped passing the request type through the app proxy. Add `JSON_ONLY` = `off` to the config table and tell whoever looks after the site.
- **Online payment doesn't show for an event.** Check the event's "Payment" field is "Online" or "Online or in store", and that `/setup?key=…` shows `"shopify": true` and `"shopifyLogin": "ok"`. Tables and GM seats are always paid at the counter.
- **Online payments stay "unpaid" on the staff page.** Open `/setup?key=…` and check `paymentWebhook` is ok. Shopify retries a failed notification for a few hours, so a short outage sorts itself out.
- **Staff page says "Staff only".** The person needs the `staff` tag on their customer account and must be logged in on the website; tags take up to 5 minutes.
- **Logs:** Cloudflare dashboard → Workers & Pages → dice-goblin-lair → Logs.

## For developers

```sh
npm test                 # rules, payments, security and race checks (Node 22+, uses node:sqlite)
npx wrangler dev         # run locally; put SHOPIFY_CLIENT_SECRET and SETUP_KEY in a .dev.vars file
```

Without `SHOPIFY_CLIENT_ID` the app runs on its built-in room list (main room T1–T21, party room P1–P4, gaming room G1–G4, fancy room F1) and default hours;
events paid "online or in store" fall back to the counter and online-only events refuse sign-ups.

Routes (all JSON; `/proxy/…` is `www.dicegoblin.nz/apps/liar/…` on the website):

| Route | Who | What |
| --- | --- | --- |
| `GET /proxy/floor?from=&to=` | anyone | bookings, holds, `eventHolds` (with `soft` and `title`), games, `eventJoins` and `eventSpots` in a window (names only for staff and your own bookings; staff also get `pass`, `covered`, `due`, `refund`, `paidAmount`, `payments`, `owed` and `waived`). Games carry `series: { id, schedule, regulars }` (or null; `regulars` is how many people are regulars), `nextOnly` and `held` (regulars' seats, up to the seats still free); `taken` counts them, and an open game is `full` once `taken` reaches `seats`. The public sees only a series' next session |
| `POST /proxy/bookings` | anyone (`gm-seat`: logged in) | `kind: table`, `gm-seat`, or `walkin` (staff); `staffOverride: true` (staff) skips the house rules; `usePass: code`; `split: true` (tables); always paid at the counter |
| `POST /proxy/bookings/:id/update` | staff, or the owner to cancel | status, paid, people, tables, end, `refunded`, `waived` (staff: let a regular off a seat; `due` becomes 0) (sign-ups too: paid, `refunded`) |
| `POST /proxy/games` | logged-in customers | list a GM game; staff can list one for a GM with `gmCustomerId` or `gmEmail` |
| `POST /proxy/games/:id/update` | staff, or the GM to cancel (`scope: session\|series`) | approve or cancel |
| `POST /proxy/games/:id/edit` | staff | change a game's details, time or tables |
| `POST /proxy/games/:id/players` | staff | seat someone, no payment |
| `POST /proxy/games/:id/sessions` | the GM or staff | add a session |
| `POST /proxy/games/:id/join-series` | logged in | become a weekly regular: a seat in the next session (`booked` items carry `ticketCode`, their member code); later ones roll forward |
| `POST /proxy/series/:id/leave` | logged in | leave a series |
| `POST /proxy/games/:id/message` | the GM or staff | email the players (5 a game a day) |
| `POST /proxy/games/:id/image`, `/proxy/gm-profile` | the GM or staff (staff: any game) | game picture, GM profile |
| `POST /proxy/games/:id/credit` | staff | pay the GM's store credit |
| `POST /proxy/blocks`, `/proxy/blocks/:id/delete` | staff | hold or release tables |
| `POST /proxy/openings`, `/proxy/openings/:id/delete` | staff | open shop tables |
| `POST /proxy/checkin` | staff | `{ code }` or `{ id, type }`, with `pass` (a code, `none`, or left out for the saved pass) and `force`: check in, use a pass; returns `row`, `pass`, `notice` |
| `POST /proxy/events/:id/join` | anyone | sign up for an event date (`pay: now\|day` when the event is paid online or in store) |
| `POST /proxy/events/:id/reserve` | anyone | book the first free game spot (`usePass: code`) |
| `POST /proxy/events/joins/:id/cancel` | staff, or the owner | cancel a sign-up |
| `POST /proxy/contact` | anyone | "host your own event" form |
| `POST /proxy/roll` | anyone (prizes: logged in) | `kind: fun\|spend` (`bonus` still works; `daily` is a 410) |
| `POST /proxy/prizes/:id/done` | staff | a dice prize given at the counter |
| `GET /proxy/me?name=` | logged in | My Lair: bookings, seats, games, sign-ups, credits, `member` (with `code`), `series`, `rolls`, `prizes`, `passes`, `tab`, `dueNow` and `gifts`. `name` (the shop account's name, sent by the theme) fills in a member's missing name, so a first visit's code has their initials. A sign-up or game spot held for online payment carries `checkoutUrl` and `holdUntil`. Bookings and seats carry `ticketCode` (a regular's seat: their member code), `owed` and `waived`. `dueNow` is what they can pay at the counter now: today's bookings, seats and sign-ups with something due, then owed seats, each `{ id, type, ref, title, start, end, amount, covered, paidAmount, due, owed }` (a table booking's title is like `Table T3` or `Tables T6 and T7`, a game spot's `Game table at <event>`). `series` items have `seriesId`, `title`, `people`, `players` and `schedule` (`weekly`, `fortnightly` or `flexible`). `passes` say where each came from: `source`, `orderName`, and on a pass bought as a product `note` ("Bought online" or "Bought at the counter"). `gifts` is this year's birthday gifts, each `{ at, credit, sessions, rolls, product: { title, code } \| null }` |
| `POST /proxy/me/profile` | logged in | first name, name, email, birthday |
| `POST /proxy/me/passes/claim` | logged in | add a pass to your account by its code |
| `POST /proxy/tab`, `/proxy/tab/clear` | logged in | save or clear today's self-serve tab |
| `GET /proxy/members?q=&sort=&owing=` | staff | search members by name, email or code (up to 25), or with no `q` the top 100 by `sort`: `spend`, `recent` (last seen) or `owing`. `owing=1` keeps those with `owed + openTab > 0`. Each has spend, `pendingPrizes`, `owed` and `owedCount` (owed seats), `openTab` (cents on an unpaid tab from an earlier day, or today's open tab), `giftedThisYear` and `rollsGifted` |
| `POST /proxy/members/:customerId/new-code` | staff | a new member code; the old one stops working |
| `POST /proxy/members/:customerId/gift` | staff | a birthday gift: any of `credit` (dollars), `sessions`, `rolls` (1 to 20 each), `productVariantId` with `productTitle`, plus `note` and `notify: true` (the email). Returns `{ gift: { id, at, credit, sessions, passCode, rolls, product, emailed, problems } }` |
| `GET /proxy/members/birthdays` | staff | birthdays in the next 30 days, with `suggested: { low, high }` (dollars), `giftedThisYear` and `lastGift` |
| `GET /proxy/passes?q=&status=`, `POST /proxy/passes` | staff | find or make session passes; every pass has `source` (`staff`, `order`, `birthday`) and `orderName` |
| `POST /proxy/passes/:id/update`, `/proxy/passes/:id/apply` | staff | change a pass; save it on a booking for check-in |
| `POST /proxy/passes/uses/:useId/undo` | staff | give a used session back |
| `GET /pos/today` | the POS extension (session token) | today's games, events and table bookings, grouped, with every person as a row |
| `POST /pos/scan`, `/pos/checkin`, `/pos/checkin-member` | the POS extension | look a code up; check one row or a member's whole day in, with cart lines. A member's rows include their owed seats (`owed: true`, earlier dates), which are never checked in; their lines are titled "Owed: <title> (<date>)" |
| `POST /pos/share`, `/pos/tab/:id/added`, `/pos/member` | the POS extension | a cart line for one share of a bill; a tab is in the cart; round 3's member lookup |
| `POST /webhooks/orders-paid` | Shopify (HMAC checked) | records payments for bookings and sign-ups, makes session passes for `LAIR-PASS-<n>` lines, marks tabs paid, adds to members' spend |
| `GET /setup?key=` | you | connection check |
| `GET /health` | anyone | uptime check |

Notes:

- Every booking lives in one Durable Object called `dice-goblin`. Checks and saves happen without an `await` in between, so two people can't take the same table; the GM credit, dice prizes and birthday gifts save their row before calling Shopify, so nothing is paid twice, and what Shopify answered is saved afterwards.
- Schema changes go at the end of `MIGRATIONS` in `src/lair.js`; each entry runs once. Only add columns (with defaults or nullable), tables and `IF NOT EXISTS` indexes there, so the live data moves across as it is; `test/lair.test.js` builds the live schema and migrates it.
- The 10-minute maintenance (the cron trigger) checks the connection, adds sessions to series, rolls weekly regulars forward, and sends the daily birthday summary (the day it went is kept in the `meta` table, so a restart doesn't send it twice).
- A `LAIR-PASS-<n>` order line makes its passes keyed by order id, line id and unit (a unique index), so a webhook sent twice, or twice at once, makes each pass once. The buyer's name is looked up on the order only for a customer who isn't a member yet, or a sale with no customer; if Shopify won't say, the pass is made anyway.
- Proxy requests are rejected unless Shopify's signature, timestamp and shop domain check out, and non-GET requests must be JSON (blocks cross-site form posts). The `internal/*` routes only answer the Worker itself.
- The orders/paid webhook records a payment only for orders whose `source_name` is `shopify_draft_order` and whose code belongs to a booking that was sent to checkout (it then asks Shopify which order that booking's draft became), or for POS orders (`source_name` `pos`) with a `_booking` line property. Each order line is recorded once in `payments` (order id and line id), so retries never count it twice, and the order's customer is the payer. A draft that was already paid is never deleted when its hold runs out. Every paid order is also looked up for members' spend, keyed by order id.
- POS routes check the POS session token with WebCrypto (HS256 with the client secret, `aud` = client ID, `dest` = the shop, `exp`/`nbf` with 60 seconds' leeway) and answer CORS for any origin, since the extension runs on Shopify's own origin.
- Emails are built by `src/email.js` (inline styles, a plain-text copy). Many at once go to Resend's batch endpoint in one request. Buttons link to `STORE_URL` (default `https://www.dicegoblin.nz`).
- Floor results are cached in memory per time window and dropped on every write, so polling pages cost almost nothing.
- Table ids are built exactly like the theme builds them (`code` + number, or a room's custom layout when it has a `box` and `tables`), so a booking for `T3` means the same table on both sides.

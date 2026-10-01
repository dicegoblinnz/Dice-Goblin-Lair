# Dice Goblin Lair: booking app

The part of the website that remembers bookings. The Shopify theme shows the floor map, the booking form,
the GM games board and the staff page; this app stores every booking, stops double bookings, takes payment
through Shopify and pays GMs their store credit.

## How it fits together

```
www.dicegoblin.nz/apps/lair/...   (the booking pages call this)
        │  Shopify's app proxy signs every request and says who is logged in
        ▼
Cloudflare Worker  dice-goblin-lair  (src/index.js: checks the signature)
        ▼
One Durable Object with a small SQLite database  (src/lair.js: bookings, games, holds, credits)
        │
        ├── Shopify Admin API: rooms and events (metaobjects), booking rules (theme settings),
        │   customer tags (staff, gm), checkouts for "pay now" (draft orders), GM store credit
        └── Shopify webhook orders/paid → marks online payments as paid
```

- Rooms come from **Content → Metaobjects → Lair rooms**, events that hold tables from **Lair events**.
- Prices, opening hours, lead time and the other rules come from the theme: **Customize → Theme settings → Lair bookings**.
- The app re-reads those every 5 minutes, so changes in Shopify show up on their own.
- Staff and trusted GMs are Shopify customers tagged `staff` or `gm`.

## What you need

- A Cloudflare account. The free plan is enough for a shop this size.
- The Shopify Dev Dashboard (dev.shopify.com), logged in as the store owner. The app has to live in the same Shopify organization as the store.
- Optional: a [Resend](https://resend.com) account if you want booking emails.

## Set up

Allow about 30 minutes. Do the steps in order.

### 1. Put the app on Cloudflare

**Without a terminal (GitHub):**

1. Put this folder in a GitHub repository. Private is fine.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository**, pick the repository and deploy. Keep the name `dice-goblin-lair`.
3. Write down the address it gives you, like `https://dice-goblin-lair.yourname.workers.dev`.

**With a terminal** (Node.js 22 or newer):

```sh
npm install
npx wrangler login
npx wrangler deploy
```

Check it: open `https://dice-goblin-lair.yourname.workers.dev/health`. You should see `{"ok":true}`.

### 2. Create the Shopify app

1. Go to dev.shopify.com → **Apps → Create app**. Call it `Dice Goblin Lair`.
2. Create a version with:
   - **App URL:** your workers.dev address. Embedding in the Shopify admin: off.
   - **Access scopes:**
     `read_customers, read_metaobjects, read_themes, read_orders, write_draft_orders, write_store_credit_account_transactions, write_app_proxy`
   - **App proxy:** prefix `apps`, subpath `lair`, URL `https://dice-goblin-lair.yourname.workers.dev/proxy`
3. Release the version, then **install** the app on the Dice Goblin store.
4. If Shopify asks about protected customer data, request it with the reason "store management". The app reads customer tags and paid orders; it doesn't need the name, email, phone or address fields.
5. Open the app's **Settings** and copy the **Client ID** and **Client secret**.

### 3. Add the secrets in Cloudflare

**Workers & Pages → dice-goblin-lair → Settings → Variables and Secrets → Add**, type **Secret**:

| Name | Value |
| --- | --- |
| `SHOPIFY_CLIENT_ID` | from step 2 |
| `SHOPIFY_CLIENT_SECRET` | from step 2 |
| `SETUP_KEY` | make up a long random password; you use it once to check the connection |

Optional, for emails (verify `dicegoblin.nz` in Resend first):

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | from Resend |
| `FROM_EMAIL` | `Dice Goblin <bookings@dicegoblin.nz>` |
| `REPLY_TO` | the shop inbox, so replies reach you |
| `STAFF_EMAIL` | gets "game waiting for approval" and "paid but cancelled" alerts |

With a terminal it's `npx wrangler secret put SHOPIFY_CLIENT_ID`, and so on.

The ordinary settings (`SHOP`, `CURRENCY`, `API_VERSION`, `THEME_ID`) are in `wrangler.toml`. `THEME_ID` points the app
at the new theme while it's unpublished; it keeps working after you publish that theme, because publishing keeps the ID.

### 4. Check the connection

Open `https://dice-goblin-lair.yourname.workers.dev/setup?key=YOUR_SETUP_KEY`. You should see:

- `"shopify": true` and `"shopifyLogin": "ok"`: the app can talk to the store.
- `"paymentWebhook": { "ok": true }`: Shopify will tell the app when someone pays. The app also sets this up by itself the first time someone uses the booking pages.
- your rooms with their prices, for example `Fancy room: 2 tables (F1…), $15.00 per person`.

If `shopifyLogin` shows an error, the client ID or secret is wrong, or the app isn't installed on the store.

### 5. Tag staff and GMs

**Shopify admin → Customers →** open the person **→ Tags:**

- `staff`: can use the staff floor page. They log in to the website with that customer account.
- `gm`: a trusted GM whose games go on the board without waiting for approval.

New tags take up to 5 minutes to count.

### 6. Switch the booking pages to live

**Online Store → Themes → Dice Goblin 2.0 → Customize → Theme settings → Lair bookings:**

- **Booking system:** Live
- **Lair app address:** `/apps/lair`
- **Let people pay online when they book:** on. Turn it off and everyone pays at the counter.

Then test on the theme preview: book a table and pay at the counter, book one and pay online with a real card (refund it
afterwards), and check both show up on the staff page.

## Day to day

- **Rooms and tables:** Content → Metaobjects → Lair rooms (number of tables, seats per table, price per person, bookable online or not).
- **Events that need tables:** Content → Metaobjects → Lair events. In "Tables" write things like `T11-T20`, `Side room 2` or `all`. Those tables can't be booked during the event.
- **Quick holds** (a market, an impromptu tournament): staff page → Hold tables.
- **Online payments** show up in Orders, tagged `lair-booking`, with the booking reference (like `GOB-7K2QXM`). Refund in Shopify as usual, then cancel the booking on the staff page.
- **GM store credit:** after the session, staff page → the game → Credit GM. It counts players marked as paid, and Shopify emails the GM about the credit.
- If someone pays after their 30-minute hold ran out and their table was taken in the meantime, the booking is flagged "refund or reseat" (and `STAFF_EMAIL` gets an alert).

## The rules the app enforces

- Bookings are in one-hour blocks, start on the hour and stay inside opening hours. Longest booking, booking lead time and how far ahead people can book come from the theme settings (defaults: 8 hours, 1 hour, 60 days).
- Nothing inside the lead time: at 1pm the first slot you can book is 2pm. Walk-ins are for anything sooner.
- Table fee is per person for the whole day ($10, or the room's own price, like $15 in the fancy room). All tables in a booking are in one room, and everyone has to fit at them.
- A table can't be double-booked; bookings, staff holds and events that list tables all count.
- Online bookings are for up to 24 people, and take at most one table more than the group size (at least 3, so one person can still set up a big-box game). Bigger groups call the shop; staff can book anything.
- GM games: 2 to 8 player seats, $15 a seat, up to 4 seats per booking. Store credit ($5 per paying player) is paid once, after the game starts. A GM can cancel their own game until it starts; after that it's a staff job. Moving or extending a game on the staff page moves its players with it.
- An online payment only counts when it comes through that booking's own Shopify checkout. Paying an ordinary shop order with a booking number in the note does nothing.
- Staff can do anything at any time; the time rules don't apply to them.
- Some light abuse limits for everyone else: at most 6 upcoming bookings per email address, and a cap on how many bookings one connection can make in 10 minutes.
- The public floor never shows names or emails. Staff holds show as "Tournament", "Market", "Event", "Out of action" or "Reserved", never the note staff typed.

## If something isn't working

- **Bookings say "The booking app only accepts JSON requests."** Shopify has stopped passing the request type through the app proxy. Add a plain variable `JSON_ONLY` = `off` in Cloudflare (Settings → Variables and Secrets) and tell whoever looks after the site.
- **"Pay now" doesn't show on the booking page.** Check that "Let people pay online" is on in the theme settings, and that `/setup?key=…` shows `"shopify": true` and `"shopifyLogin": "ok"`.
- **Online payments stay "unpaid" on the staff page.** Open `/setup?key=…` and check `paymentWebhook` is ok. Shopify retries a failed notification for a few hours, so a short outage sorts itself out.
- **Staff page says "Staff only".** The person needs the `staff` tag on their customer account and must be logged in on the website; tags take up to 5 minutes.
- **Logs:** Cloudflare dashboard → Workers & Pages → dice-goblin-lair → Logs.

## For developers

```sh
npm test                 # rules, payments, security and race checks (Node 22+, uses node:sqlite)
npx wrangler dev         # run locally; put SHOPIFY_CLIENT_SECRET and SETUP_KEY in a .dev.vars file
```

Without `SHOPIFY_CLIENT_ID` the app runs on its built-in room list (T1–T20, A1–A4, B1–B4, F1–F2) and default hours, and
"pay now" falls back to paying at the counter.

Routes (all JSON):

| Route | Who | What |
| --- | --- | --- |
| `GET /proxy/floor?from=&to=` | anyone | bookings, holds and games in a window (names only for staff and your own bookings) |
| `POST /proxy/bookings` | anyone | `kind: table`, `gm-seat`, or `walkin` (staff); returns `booking`, plus `checkoutUrl` for pay now |
| `POST /proxy/bookings/:id/update` | staff, or the owner to cancel | status, paid, people, tables, end |
| `POST /proxy/games` | logged-in customers | list a GM game |
| `POST /proxy/games/:id/update` | staff, or the GM to cancel | approve or cancel |
| `POST /proxy/games/:id/credit` | staff | pay the GM's store credit |
| `POST /proxy/blocks`, `/proxy/blocks/:id/delete` | staff | hold or release tables |
| `POST /webhooks/orders-paid` | Shopify (HMAC checked) | marks bookings paid |
| `GET /setup?key=` | you | connection check |
| `GET /health` | anyone | uptime check |

Notes:

- Every booking lives in one Durable Object called `dice-goblin`. Checks and saves happen without an `await` in between, so two people can't take the same table; the GM credit claims the game before calling Shopify, so it can't be paid twice.
- Schema changes go at the end of `MIGRATIONS` in `src/lair.js`; each entry runs once.
- Proxy requests are rejected unless Shopify's signature, timestamp and shop domain check out, and non-GET requests must be JSON (blocks cross-site form posts). The `internal/*` routes only answer the Worker itself.
- The orders/paid webhook only acts on orders whose `source_name` is `shopify_draft_order` and whose booking ref belongs to a booking that was sent to checkout; it then asks Shopify which order that booking's draft became. A draft that was already paid is never deleted when its hold runs out.
- Floor results are cached in memory per time window and dropped on every write, so polling pages cost almost nothing.
- Table ids are built exactly like the theme builds them (`code` + number, or a room's custom layout when it has a `box` and `tables`), so a booking for `T3` means the same table on both sides.

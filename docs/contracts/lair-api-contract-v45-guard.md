# Lair API contract v45-guard: the website's forms, pass codes and the tab's prices (17 Nov 2026)

Before Mo's ads bring strangers to dicegoblin.nz, the three holes the 16 Nov review found are closed. Where this and an
older contract disagree, this one wins. Code: `src/guard.js`, `src/tab.js` (`tabPriced`, `tabPricesView`), `src/lair.js`.
Checks: `test/round45-guard.test.js`.

## 1. Fake bookings

### 1.1 The robot check (Cloudflare Turnstile)

- **Config:** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (D1 `config` table or Worker secrets; the secret belongs in
  a Worker secret). **Off until both are set**: nothing is asked and nothing changes.
- **`GET /guard`** (anyone, before anyone is looked up) → `{ turnstile: { siteKey } | null }`. Never the secret.
- **Guarded forms** (POST, for someone who isn't logged in): `/bookings` (tables and seats), `/events/:id/join`,
  `/events/:id/reserve`, `/interest` (interest, Maybe and the waitlist), `/contact`, `/pick/:id/email`. The body carries
  `turnstile`: the token from Turnstile's widget. The Lair asks `https://challenges.cloudflare.com/turnstile/v0/siteverify`
  (`secret`, `response`, `remoteip` = the shopper's address) before anything else.
  - No token, or Cloudflare says no → **403** `{ error, guard: 'turnstile' }`, `error` = "Gobgob couldn't tell you're not a
    robot. Refresh the page and try again, or log in to skip the check."
  - Logged-in members and staff are never checked.
  - Cloudflare can't be reached (5 seconds, a network error or a 5xx) → the request goes on (a 4xx is a failed check, never this), and `turnstileDown` is noted in the status
    table. The limits below still hold.
  - A token works once: the page gets a fresh one for every send.

### 1.2 The day's cap on bookings without an account

- **`GUEST_NIGHT_CAP`** (config): the most bookings and sign-ups made without an account for any one day (the day the
  booking is for, in Auckland time). Not set: **20**. `off`: no cap. `0`: none without an account.
- Counted together: tables, seats and game spots (`bookings` with no customer and no `added_by`, kind `table` or
  `gm-seat`, still on) and event sign-ups (`event_joins` with no customer and no `added_by`, not cancelled or no-show).
- One more → **429** "We've taken a lot of bookings without an account for that day. Log in or make a free account to book
  it, or give us a call." Members and staff aren't counted or capped.

### 1.3 Limits that survive a restart

Kept in the Durable Object's table `guard_hits (bucket, at)`, cleared after a day, instead of in memory:

| Limit | Bucket | Answer |
| --- | --- | --- |
| 20 bookings, sign-ups or interest from one address in 10 minutes (as before) | `book:<address>` | 429 "Too many bookings in a short time. Call us and we will sort it out." |
| 3 event ideas an hour from one address (as before) | `idea:<address>` | 429 "We've got your messages. The team will be in touch soon." |
| 30 emailed picks an hour a member or address (as before) | `pickmail:<key>` | 429 (Help me pick's busy words) |
| 10 code tries in 10 minutes a member, claim and "Got a code?" together (as before) | `claim:<customer>` | 429 "Too many tries in a row. Give it ten minutes, or ask us at the counter." |
| 20 wrong codes across the shop in 24 hours (new, section 2) | `wrong-code` | see 2.2 |
| 10 failed robot checks across the shop in 10 minutes (a burst; staff hear) | `robot-fail` | |

### 1.4 One email to staff when a burst is blocked

To `STAFF_EMAIL`, subject "Website: a burst was blocked", when an address hits its 20 in 10 minutes, a day hits its cap,
ten robot checks fail in 10 minutes, or wrong codes pause claiming. **At most one an hour** (bucket `alert`, so a restart
doesn't send another). It says what happened, when, and the address where there is one.

## 2. Pass codes nobody can guess

### 2.1 Long codes for unclaimed passes

A pass nobody is linked to is claimed by whoever has its code, so it gets a long code: initials, a word, a d20 and four
random letters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, like `AN-OWLBEAR-17-K7QM` (`DG` with no name). That's:

- a pass sold on an order with no customer (contract v5: "Sold at the counter", or the billing name);
- every session gift (contract v6; experiences already had them, 16 Nov 2026);
- a pass staff make with no member and no group (a group's pass can't be claimed, so it keeps a short code).

A pass linked to a member, and birthday passes, keep the short code. **Every existing code keeps working.** Matching still
ignores case, spaces and dashes.

### 2.2 The shop-wide cap on wrong guesses

A wrong code is counted across the whole shop: `POST /me/passes/claim` answering 404 (no pass) or 409 (a group's, or
someone else's), and `POST /me/codes/redeem` answering 404. After **20 in 24 hours**:

- Both routes answer **429** "Lots of wrong codes have been tried today, so codes are paused online for now. Ask us at the
  counter and we'll add it for you." for any code that isn't a long pass code or a known loot or invite code, real or not,
  so nothing can be learned from the answer.
- A long pass code still claims; loot and invite codes still work; staff at the counter are unaffected.
- It lifts once the 24 hours have fewer than 20. Staff get the one email (1.4).

## 3. My tab is priced by the Lair

- **`POST /tab { items: [{ variantId, qty }] }`**: `title`, `variantTitle` and `price` sent by the page are **ignored**.
  The Lair asks Shopify (Admin API `nodes`, the till's API version) for each variant: its price, its product's title and
  its own title. A variant Shopify doesn't know, or whose product isn't active or is a gift card → **422** "Gobgob doesn't
  know that one. Pick it from the menu instead."
- **Shopify can't answer:** the counter's two drinks go on at the Lair's own price list (`TAB_COUNTER_DRINKS` in
  `src/tab.js`: Can of Drink, variant `51525157716071`, $3; Water 600ml, variant `51525157683303`, $2); anything else →
  **503** "Gobgob can't check that price right now. Try again in a minute, or add it at the counter."
- The saved tab (and the till, the counter and a monthly bill, which charge the tab's prices) now carries Shopify's prices.
  The other rules (30 lines, 1 to 20 of each, merged, the in-cart lock) are as in contract v4.
- **`GET /tab/prices`** (logged in) → `{ drinks: [{ productId, variantId, title, price }] }`: the two counter drinks at
  Shopify's price (kept 5 minutes), or the Lair's own when Shopify can't answer. My Lair's menu shows these.

## 4. The theme

- `assets/lair-guard.js` (`window.LairGuard`): reads `GET /guard` once a page; with a site key, loads Turnstile's script on
  the first guarded send, runs an invisible widget (shown only if Cloudflare wants a tap, in a small panel with Gobgob's
  line), and gives the token. `lair-core.js` (every guarded call in `LiveBackend.request`) and `help-me-pick.js` (Email my
  picks) add it as `turnstile` when nobody is logged in. Nothing happens while the Lair says it's off.
- My Lair's tab menu takes the drinks' prices from `GET /tab/prices`, and shows the tab as the Lair saved it.

## Review notes (17 Nov 2026)

- `events/:id/join` and `events/:id/reserve` need the check with anything after them too, since their routes don't look past `join` or `reserve`.
- Failed checks stop adding rows to `guard_hits` once the 10-minute count is already a burst, so a flood of junk can't grow the table.

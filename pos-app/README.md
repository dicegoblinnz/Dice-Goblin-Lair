# Lair check-in for Shopify POS

A tile on the Shopify POS home screen for the Dice Goblin counter. It shows who's booked today (GM games, events
and table bookings), checks people in, and puts what they owe in the POS cart. Then the check-in screen closes by
itself, so staff take payment straight away with **Pay on Verifone**. Once a sale is paid, the Lair app marks the
booking, sign-up or tab paid by itself.

This folder is a Shopify app project: `shopify.app.toml` holds the app's settings and `extensions/lair-checkin` is
the tile. It talks to the Lair app (the Cloudflare Worker at the root of this repository).

## At the counter

The tile says **Lair check-in** and today's numbers, like "9 of 27 here · 2 to pay". The number on the tile counts
the bookings here with something still to pay that isn't in the cart yet. Tap the tile.

A person's screen shows, from the top: who it is, **To pay** in big numbers, and a line saying what's in the cart
("In the cart: $15 · Sam Jones"). The big button is always the next step. If someone else's sale is in the cart, a
yellow box says so: if they're paying apart, take that payment first.

The scanner works on every screen: scan a code any time and the screen jumps to it. **Scan a code** (or **Scan** at
the top) opens the camera instead.

### Someone arrives with a ticket

1. Scan their code. Codes look like `SJ-OWLBEAR-17` (older ones look like `GOB-7K2QXM`).
   - **Left their phone at home?** Type their name in the search box, or their code (capitals, spaces and dashes
     don't matter: `sj owlbear 17` works). Or tap their game, event or "Table bookings", then tap them.
2. The screen asks **"Are you Sam?"** and shows what they booked, when, their tables, the players' names for a GM
   game, any note, and **To pay**. Check it's them.
3. Tap **Check in and add $15 to cart**. They're checked in, their fee goes in the cart with them on the sale, and the
   check-in screen closes by itself.
4. Tap **Pay on Verifone**.

So a ticket is: the tile, a scan, one button, then Pay on Verifone.

- **Paying later?** Tap **Just check in (pay later)**. They're in, nothing goes in the cart, and it stays on their
  booking (their member code shows it next time).
- **Nothing to pay** (paid online, a pass covers it, or the GM pays): the button just says **Check in**. The screen
  then says "Sam's in" and why there's nothing to pay. Tap **Done**, or scan the next code.
- **Another day, cancelled or a no-show:** a yellow box says so and the button reads **Check in anyway**. Only tap it
  if that's OK. Then tap **Add $15 to cart**.
- **Check before they pay:** if the Lair app has something to say about the check-in (a pass that only covered some
  of them, say), the screen stays open and shows it. Sort it out with them, then tap **Close and pay**.
- **The screen didn't close by itself?** It shows **In the cart** with a big **Close and pay** button. Tap it, then
  Pay on Verifone. (Shopify POS sometimes won't let a screen close itself; tapping the button always works.) Tap
  **Add someone else to this sale** to add another person to the same sale first.

### A session pass

- **Their booking has a saved pass:** a switch shows it, turned on ("Warhammer league · 7 left (saved on the
  booking)"), and the button says **Check in with the pass**. Each session covers one person's table fee; anything
  the pass doesn't cover goes in the cart. To pay instead, turn the switch off.
- **They have more than one pass:** pick one, or **Don't use a pass**.
- **Another pass:** scan it (on their screen, a pass code becomes one of their choices), or tap **Use a session
  pass** / **Scan a different pass** for the camera.
- **Here already, with something to pay?** Pick a pass under **Use a pass for what's left?**, then tap **Use the
  pass**. Anything it doesn't cover goes in the cart and the screen closes.
- A pass covers one person's table fee per session (never event entry or a GM's fee).

### Wrong pass?

After a check-in that used a pass, the person's screen shows the pass in use:

- **Undo pass** gives the session back, and the screen shows what's to pay now ("Pass undone. $45 to pay.").
- To use a different pass, pick it and tap **Switch to this pass**: the first one is undone, then they're checked in
  again with the new one.
- Pick **Don't use a pass** and tap **Check in again without a pass** to pay the full amount instead.

This works for someone checked in earlier too: open them again and the pass in use is there. If their fee is already
in the cart, take that line off the sale first. (The staff page can undo a pass as well, under Passes.)

### Splitting the bill

When they said "Split the bill at the counter" when booking, or part is paid already, the button says **Check in,
then split the bill** (and **Split the bill** once they're here). For any other booking of two or more, it's the
quieter button under the main one.

1. Pick **One person's share** (the screen shows how many are left to pay and how much each) or **A different
   amount** and type it.
2. **Who's paying this share?** Tap the booker's name, or scan their member code (the code in their My Lair), or type
   it and tap **Find**. They go on the sale, so their spend counts for *them*. No member code? Go ahead anyway.
3. Tap **Add $10 to cart**. The screen closes: take payment with Pay on Verifone.
4. For the next friend, scan the booker's code again (or find them in the list). It shows what's been paid and
   what's left. Right after a payment the button says **Refresh** ("Waiting for the last payment…"): tap it after a
   few seconds. If that payment didn't go through after all, tap **It wasn't paid**.

### A group paying together

1. Tap their game, event or "Table bookings".
2. Tap **Check in several at once**. Everyone still to come is ticked.
3. Untick anyone paying on their own.
4. Tap **Check in 3 people and add $45 to cart**. The screen closes: take payment with Pay on Verifone.

Saved passes come off as they check in, so the cart can come to less (the screen says so). If a pass only covered
some of them, or the Lair app wouldn't check someone in, the screen stays open under **Check before they pay** and
names them. When the ticked bookings are all one person's, that person goes on the sale. Someone here already with
something to pay can be ticked too. Anyone paying on their own: scan their code, or tap their name.

### A member code

Scanning someone's member code (from My Lair) shows their loyalty card, **To pay**, and one button:

- **Check in and add everything · $41** checks in their bookings today, adds today's fees, any sessions they owe from
  earlier weeks, any player's seats they're paying for as a GM, and their tab, and puts them on the sale. The screen
  closes: take payment with Pay on Verifone.
  - Under **To pay** it says what it's made of, like "Today $15 · Owed $15 · Tab $11".
  - A saved session pass comes off when they check in, so the cart can come to less (the screen says so).
  - The tab goes in as the real products, so the till charges the shop's own prices.
  - With just one thing to pay, the button names it: **Check in and add $15 to cart**, or **Add $15 to cart**.
  - If the Lair app has something to say (a pass that only covered some of them, someone it wouldn't check in), the
    screen stays open under **Check before they pay**. Sort it out, then tap **Close and pay**.
- **Only paying for part?** Tap that row under Today, Paying for players or Owed, or **Add just the tab**.
- **Put Sam on this sale** (at the bottom) puts them on the sale without adding anything.
- **A monthly account:** the button is **Check in**, and today's fees go on their account. **Pay now: …** is there
  if they'd rather pay now.
- A weekly regular's ticket *is* their member code.

### Their loyalty card

A member code shows their card: a star for each stamp, like "9 of 10 stamps. One more fills it.", and any rolls
waiting in My Lair. Stamps come from check-ins, and they roll in My Lair: it's for show here.

When a check-in fills their card, the screen says **"Sam's loyalty card is full! A roll for store credit is waiting in
My Lair."** (and the message at the bottom of POS says the card is full). Let them know.

(A ticket shows the card too once the Lair app sends it with tickets: see "What we've asked the Lair app for" below.)

### Weekly regulars and owed sessions

**Weekly** on someone's seat means they're a weekly regular (they tapped "Join every session" on the website): their
seat is saved for them every week. A regular's seat is theirs to pay for, even if they don't come, so once a session
has ended unpaid it's **owed**.

- Their owed sessions show under **Owed** when you scan their member code, each with its date ("Thu 1 Oct,
  6pm–9pm"). **Check in and add everything** includes them, as lines like "Owed: Curse of Strahd (Thu 1 Oct)".
- Tap one to pay just that one: the screen says **Owed from …** with **Add $15 to cart**. An owed session is never
  checked in, and passes aren't used on it.
- Letting them off? Waive it on the staff page (open the booking). It stops showing as owed.

### GM pays for a player

A GM can pay the table fee for one of their players' seats ($10 at today's prices): the player pays nothing, and the
GM's charge goes on the GM's account. The GM gets no GM credit for that seat.

1. Open the player: scan their code, or tap them in the game.
2. Tap **Kate pays for this seat**. The screen asks **"Kate pays for Mia's seat?"**. Tap **Yes, Kate pays**.
3. Mia now has nothing to pay: tap **Check in**.

- Kate pays her charge like any booking: scan her member code and **Check in and add everything** (it shows as
  "Players' seats $10"), or it waits on her tab. Scanning the charge's own code shows "Paying for Mia's seat: Curse
  of Strahd" with **Add $10 to cart**. A charge is never checked in.
- To undo it, open Mia and tap **Stop Kate paying**, then **Yes, stop Kate paying**. Mia's seat goes back to its full
  price. If Kate had paid already, staff get an email to give that money back.
- The button only shows on a seat with something to pay and nothing paid on it yet. While Mia's own fee is in the
  sale, the screen says to take it off first. If the Lair app says no (the GM has no Dice Goblin account, say), the
  screen says why.
- A player who doesn't come pays for their own seat: mark the no-show on the staff page as usual.

### A session pass code

Scanning a pass shows who has it and how many sessions are left. Tap **Use on…**, then the booking it's for: that
person is checked in with the pass and the screen shows what's left to pay.

### Today's list

- **Now and next:** games and events on now or starting within two hours, and the table bookings, each with who's
  here ("3 of 5 here") and what's to pay ("$30 to pay"), or when it starts ("Starts at 7pm").
- **Later today:** the rest.
- **Finished:** shown when someone there still has something to pay; otherwise tap **Show finished**.

### What the labels mean

| Label | Means |
| --- | --- |
| Here | Checked in |
| Paid | Already paid (online, or earlier) |
| Free | Nothing to pay (a free event, say) |
| Due $X | Still to pay |
| Owed $X | A weekly regular's session that has ended unpaid: still theirs to pay |
| Weekly | A weekly regular's seat: saved for them every week |
| GM pays | The GM is paying for this player's seat |
| In cart | Its fee is in this sale, waiting for payment |
| Pass | They'll use their saved session pass |
| No-show | Marked as not coming |
| Refund? | They paid online, then cancelled or didn't come: sort out a refund on the staff page |

## One-time setup (Mo, on your phone)

Steps 1 to 4 are done: a change under `pos-app/` that lands on `main` deploys by itself. They're kept here for
reference, and the key needs renewing every 6 months (see the end of this section). Steps 5 and 6 are for a new
iPad or a new staff login.

Use your phone's web browser (Safari or Chrome) for GitHub, not the GitHub app: the app can't add secrets.

### 1. Make a deploy key in the Shopify Dev Dashboard

1. Open https://dev.shopify.com/dashboard and log in.
2. Tap **Apps**, then **Dice Goblin Lair**, then **Settings**.
3. Scroll to **App Automation Token** and tap **Create token**.
4. Under **Expiration**, pick **6 months** (the longest Shopify offers), then tap **Generate token**.
5. Copy the token straight away: Shopify only shows it once. Paste it in step 2 and nowhere else.
6. Add a calendar reminder for 5 months from today: "Renew the POS deploy key" (see the end of this section).

### 2. Give the key to GitHub

1. Open https://github.com/dicegoblinnz/Dice-Goblin-Lair/settings/secrets/actions/new
   (that's the repository's **Settings → Secrets and variables → Actions → New repository secret**).
   If you see a small mobile page without **Settings**, choose **Request desktop website** in your browser's menu.
2. **Name:** `SHOPIFY_APP_AUTOMATION_TOKEN` (exactly that).
3. **Secret:** paste the token.
4. Tap **Add secret**.

### 3. Check the app's settings, once

Every deploy makes the app's settings in the Dev Dashboard match `shopify.app.toml`. They were copied from the live
app, but check them once. In the Dev Dashboard open **Dice Goblin Lair → Versions** and tap the active version:

| Setting | Should be |
| --- | --- |
| App URL | `https://dice-goblin-lair.dicegoblinnz.workers.dev`, not embedded in the admin |
| Scopes | `read_customers`, `read_metaobjects`, `read_themes`, `read_orders`, `write_draft_orders`, `write_store_credit_account_transactions`, `write_app_proxy`, `write_discounts`, `read_products`, `read_inventory`, `write_metaobjects`, `write_files`, `read_store_credit_accounts` |
| Redirect URLs | none |
| App proxy | prefix `apps`, subpath `liar`, URL `https://dice-goblin-lair.dicegoblinnz.workers.dev/proxy` |
| Webhooks API version | `2026-10` |

If you see anything else there (a redirect URL, say), ask Claude to add it to `shopify.app.toml` before the first
deploy, or the deploy will remove it. The live app's name currently ends with a space ("Dice Goblin Lair "); the
deploy tidies that up.

### 4. Deploy

Deploys run by themselves whenever a change under `pos-app/` lands on `main`. Until the token from step 2 is
saved, those runs skip the deploy and show a yellow note saying the token is missing; nothing breaks. Once the
token is saved, run the first deploy by hand:

1. Open https://github.com/dicegoblinnz/Dice-Goblin-Lair/actions/workflows/pos-deploy.yml
2. Tap **Run workflow**, leave the branch on `main`, and tap **Run workflow** again.
3. After 2–3 minutes it shows a green tick. A red cross means it didn't deploy: tap the run, then the step with the
   cross, to read why. To retry a run, open it and tap **Re-run jobs**.

After a deploy, close Shopify POS on the iPad completely and open it again to get the new check-in screen.

### 5. Put the tile on the POS home screen

1. Shopify admin → **Sales channels → Point of Sale**. Under **Customize the in-store experience**, tap **Edit**
   next to **POS app**.
2. Under **Smart grid**, pick the layout the counter uses.
3. Tap **⊕ Add tile → Embedded Apps → Dice Goblin Lair** (Lair check-in), then **Add** and **Save**.
4. On the iPad or phone, close Shopify POS completely and open it again.

Not in the list? Shopify admin → **Point of Sale → Settings → POS apps**: check Dice Goblin Lair is there and turned
on for the shop.

### 6. Let the POS login use it

The tile works for the Shopify account the POS is logged in with (not the PIN of whoever is serving). The owner's
account always can. For a staff account: Shopify admin → **Settings → Users** → that person → give them access to
the **Dice Goblin Lair** app → **Save**. Without that, the check-in screen says "This POS login has no access".

### Every 6 months: renew the deploy key

An expired key only stops deploys; the tile keeps working. To renew it:

1. Dev Dashboard → **Dice Goblin Lair → Settings → App Automation Token → Rotate**, pick **6 months**, tap
   **Generate token** and copy it.
2. Open https://github.com/dicegoblinnz/Dice-Goblin-Lair/settings/secrets/actions, tap the pencil next to
   **SHOPIFY_APP_AUTOMATION_TOKEN**, paste the new token and tap **Update secret**.
3. Run a deploy by hand (step 4). Once it's green, go back to the Dev Dashboard and tap **Revoke** next to the old token.

## When something goes wrong

Each problem says what to do next, and its button is the next step.

| The screen says | What to do |
| --- | --- |
| In the cart (instead of closing) | Tap **Close and pay**, then Pay on Verifone. POS sometimes won't let the screen close itself. |
| Check before they pay | The Lair app said something about the check-in, like a pass that only covered some of them, or someone it wouldn't check in. Sort it out with them, then tap **Close and pay**. |
| Can't reach the Lair app | Check the iPad's internet and tap **Try again**. If the internet works and it always says this, the Lair app may be missing its latest update. |
| This POS login has no access | Step 6 above, or log the POS in with the owner's account. |
| The Lair app didn't accept this POS login | Close the check-in screen and open it again. If it keeps happening, the Lair app's Shopify client ID or secret doesn't match this app. |
| We couldn't find SJ-OWLBEAR-71 | Check the code with them, or search by name. **Scan again** tries another scan. |
| That's not a Lair code | The scanner read something else, like a product barcode. **Scan again**. |
| It isn't in the cart | Add it by hand as a custom sale, with the title and price shown. |
| It's in the cart, but not linked | After they pay, mark the booking paid on the staff page. |
| Already in the cart | That booking already has a line in this sale: take that payment first (**Close and pay**), or take the line off the sale. |
| Nothing to add | Everything of theirs is paid, or in this sale already. Something waiting in the sale? Tap **Close and pay**. |
| Someone else's sale in the cart (yellow box) | If they're paying apart, take that payment first. Paying together? Carry on. |
| Not everyone was checked in, or No one was checked in | Open the people it names to check them in anyway (another day, say). |
| Waiting for the last payment… | The payment hasn't reached the Lair app yet: tap **Refresh** in a few seconds. Didn't go through? Tap **It wasn't paid**. |
| Couldn't find that pass use | Undo it on the staff page, under Passes, then open them again here. |
| The tile says "App failed to load" | Close and reopen Shopify POS, and update it from the App Store. If it continues, note the device and iOS version and ask Claude. |

## What the Lair app (the Worker) does for this

The check-in screen talks to the Worker directly, at `https://dice-goblin-lair.dicegoblinnz.workers.dev/pos/…`, with
`Authorization: Bearer <POS session token>` (API contract v4, sections 7 and 11, v5 section 2, and v21-gm-cover):

| Route | What for |
| --- | --- |
| `GET /pos/today` | Today's groups and everyone in them (the home screen, and the tile's numbers) |
| `POST /pos/scan { code }` | What a scanned or typed code is: a booking or sign-up, a member, or a pass. A member's `rows` are today's, then their owed sessions (`owed: true`, each with its cart `line`); a GM's charges for their players' seats are among today's (`kind: 'gm-cover'`) |
| `POST /pos/checkin { id, type, pass?, force? }` | Check one person in; `pass` is a pass code, `'none'`, or left out for their saved pass. Answers with cart lines and any `notice` (a pass that covered only some of them). A GM's charge (`kind: 'gm-cover'`) is never checked in: it answers `reason: 'cover'` with its line |
| `POST /pos/share { id, type, amount? }` | One share of a bill as a cart line |
| `POST /pos/pass-undo { useId }` | Give a pass use back (the same as the staff page's undo); answers `{ pass, row }` |
| `POST /pos/tab/:id/added` | A member's tab is in the cart |
| `POST /pos/cover { gameId, ref }` | The GM pays for a player's seat (contract v21-gm-cover); answers `{ seat, cover, game }` |
| `POST /pos/uncover { gameId, ref }` | The GM stops paying for it; answers `{ seat, cover: null, game }` |

- The session token is a JWT signed HS256 with the app's client secret, `aud` = the client ID, `dest` =
  `https://ep0qiq-rp.myshopify.com`. Errors come back as `{ error: "Plain sentence" }` and the screen shows them.
- **CORS:** POS calls from Shopify's own origin, so `/pos/*` answers `OPTIONS` and allows `GET, POST`, the
  `Authorization` and `Content-Type` headers, and any origin. Without it, every scan says "Can't reach the Lair app".
- **Cart lines:** fees are custom sales carrying `_booking: <code>` (and `_share: '1'` for a share of a bill); an owed
  session is one too, titled "Owed: <game> (<date>)" and carrying its seat's code, and so is a GM's charge ("Paying for
  Mia's seat: Curse of Strahd (<code>)"). Tab items are the real products carrying `_tab: <tab id>`. When the POS
  order is paid, the orders/paid webhook records each `_booking` line as a payment towards that booking or sign-up and
  marks each `_tab` tab paid.
- **Closing by itself:** once everything went in the cart cleanly and the check-in had no `notice`, the screen calls
  `window.close()` (POS UI extensions 2026-07). When something needs sorting out (a line POS refused, a line without
  its booking tag, someone not put on the sale, a notice from the check-in), it stays open and says what to do, with
  **Close and pay** when there's something in the cart. When `window.close()` doesn't close it, staff see "In the
  cart" with **Close and pay**, which calls it again from the tap.
- **Add everything:** looks the member's code up again (`/pos/scan`), then goes one row at a time with
  `/pos/checkin`: each booking still to come is checked in (their saved pass applies), and each one here already and
  still owing, and each GM charge, is asked for its lines with `pass: 'none'`. It doesn't use
  `/pos/checkin-member`: that checks in again every booking already here, with its saved pass, so it would use a pass
  on a booking staff checked in without one. Each answer goes on screen as it comes, so if the internet drops
  halfway, **Try again** does only the rest. Then today's lines and the owed lines go in, then the tab's items, then
  the customer, then `/pos/tab/:id/added`. Anything already in the cart is skipped, so a second tap never charges
  twice. After a check-in it looks the member up once more (up to 2.5 seconds) to see whether their loyalty card
  filled.
- **A group:** each ticked person still to come is checked in with `/pos/checkin` (their saved pass applies), each
  ticked person already here is asked for their lines with `pass: 'none'`, and every line goes in one sale.
- **Split the bill:** `/pos/share` answers with the share's line. The iPad saves the share before the screen closes,
  so the booking says "Waiting for the last payment…" until that payment reaches the Lair app.
- **GM pays:** the player's screen offers it on a GM game seat with something to pay and nothing paid or taken off
  it, and not while the seat's own fee is in the sale; the Lair app refuses, in words, a seat the GM can't pay for.
  After `/pos/cover` the screen looks the seat up again (`/pos/scan`) for its $0 row.
- **Weekly:** a row with a `seriesId` is a weekly regular's seat. A row with `owed: true` is paid, never checked in.
- **Passes:** a check-in that used a pass answers with its `pass.useId`, which **Undo pass** sends to
  `/pos/pass-undo`. For someone checked in earlier, the screen finds the use from the pass itself (`/pos/scan` of a
  pass code lists its uses). Switching undoes the pass in use first, then checks in again with the new choice (a pass
  code, or `'none'`). **Use the pass** for what's left checks in again with the pass picked. Asking for the cart lines
  again always sends `pass: 'none'`, so it never uses a pass by itself.
- **The tile** asks for `/pos/today` when it appears, 8 seconds after a sale with Lair lines leaves the cart (it was
  probably paid), and when its numbers are over 15 minutes old as the cart changes (at most once a minute). In
  between it uses the numbers the check-in screen saves as it works. No polling.

### What we've asked the Lair app for (27 Oct 2026)

The check-in screen already works without these; each makes it better once the Worker sends it.

1. **GM pays on the counter's rows.** On rows of `kind: 'gm-seat'` in `GET /pos/today`, `POST /pos/scan` and the
   `/pos/checkin` answers: `gmPays: { on, can, amount, payer }` (`on`: the GM pays for it; `can`: they could, the
   same rule as the board's `coverable`; `amount`: cents the GM pays or would pay; `payer`: that GM's first name).
   Not `covered`, which on these rows already means what a session pass took off. And `/pos/cover` and
   `/pos/uncover` answering with the seat's counter row as `row`. Until then the screen works out whether to offer it
   from the seat, shows "Free" (not "GM pays") on a seat the GM pays for once the screen is reopened, and says the
   table fee's amount only after the GM pays.
2. **The loyalty card on tickets.** `loyalty` (`{ stamps, cardSize, rollsAvailable, card }`, as for a member code) in
   `POST /pos/scan` for a booking or sign-up on an account, and in the `/pos/checkin` answer as it is after the
   check-in. Then a ticket shows the card too, and says straight away when a check-in fills it.

## For developers

```
cd pos-app
npm ci
npm test        # the logic: codes, the Today list, badges, passes, split bills, cart lines, the cart strip, loyalty, Worker calls
TZ=UTC npm test # the same on UTC, like GitHub's runner
npm run check   # type-checks the extension against the POS API types (2026-07)
npm run build   # bundles the extension (works offline, no Shopify login needed)
```

Tests use fixed times, never today's date or the computer's time zone: a test that leaned on the clock once broke a
deploy. Times are shown in Auckland time whatever the device says.

- POS UI extensions API `2026-07` (Preact with Polaris web components such as `s-button`), Shopify CLI 4.
- `extensions/lair-checkin/src`:
  - `Tile.jsx` (the home tile) and `Modal.jsx` (the check-in screen: state, scanning, closing, and every call to the
    POS and the Worker); `views.jsx` draws the screens from what `Modal.jsx` hands it.
  - Plain modules with tests in `test/`: `codes.js` (reading codes), `format.js` (money, times in Auckland),
    `today.js` (the Today list, badges, search, the tile's numbers, GM pays), `flow.js` (which screen next, each
    screen's main button, groups, pass choices, where a scan goes, what happens after the cart), `split.js` (shares of
    a bill), `lines.js` (cart lines and toasts), `cart.js` (the POS cart), `sale.js` (the cart strip),
    `loyalty.js` (the loyalty card), `lair.js` (Worker calls and error banners), `store.js` (what the iPad remembers
    between visits).
  - `shopify.d.ts` is generated by the CLI (`npm run build` rewrites it).
- `.github/workflows/pos-deploy.yml` (at the repository root) runs the tests and the type check, then
  `shopify app deploy --config shopify.app.toml --allow-updates` with `SHOPIFY_APP_AUTOMATION_TOKEN`.
  `--allow-updates` adds and updates but never deletes: if a deploy fails because it would remove something from
  the app, find out why rather than adding `--allow-deletes`.
- Change app settings in `shopify.app.toml`, not in the Dev Dashboard: the next deploy overwrites the Dashboard.
- Never change the extension's `handle` or `uid`: Shopify would treat it as a new extension and the tile would have
  to be added to POS again.
- `shopify app dev` previews on a dev store; `automatically_update_urls_on_dev = false` keeps it off the live URLs.
- Cloudflare doesn't run anything in this folder. Workers Builds still rebuilds the Worker on every push to `main`,
  POS-only changes included, which is harmless. To skip those, add `pos-app/*` to the Worker's build watch paths
  **Exclude** list (Cloudflare → Workers & Pages → dice-goblin-lair → Settings → Build).

# Lair check-in for Shopify POS

A tile on the Shopify POS home screen for the Dice Goblin counter. It shows who's booked today (GM games, events
and table bookings), checks people in, and puts what they owe in the POS cart, so staff take payment the usual way
with **Pay on Verifone**. Once a sale is paid, the Lair app marks the booking, sign-up or tab paid by itself.

This folder is a Shopify app project: `shopify.app.toml` holds the app's settings and `extensions/lair-checkin` is
the tile. It talks to the Lair app (the Cloudflare Worker at the root of this repository).

## At the counter

The tile says **Lair check-in** and today's numbers, like "14 today · 5 here". Tap it.

### Someone arrives

1. Tap **Scan a code** and point the camera at the code they show you: the QR code on their ticket or in My Lair.
   A barcode scanner works too. Codes look like `SJ-OWLBEAR-17` (older ones look like `GOB-7K2QXM`).
   - **Left their phone at home?** Type their name in the search box, or type their code (capitals, spaces and
     dashes don't matter: `sj owlbear 17` works).
   - Or tap their game, event or "Table bookings" under **Today**, then tap them.
2. The screen asks **"Are you Sam?"** and shows their code, how many people, their tables and time, the players'
   names for a GM game, any note, and their session pass if they saved one. Check it's them.
3. **Session pass?** If they have one, it's already picked. Pick another of theirs, or **Don't use a pass**, before
   you check them in. A pass covers one person's table fee per session (never event entry or a GM's fee).
   Changed your mind after checking in? See "Wrong pass?" below.
4. Tap **Check in**. The screen shows what's left to pay after any pass.
   - Nothing to pay: it says **"Checked in. Nothing to pay."** Tap **Done**.
   - Something to pay: tap **Add $X to cart**. It says "Added $X. Ready to pay." and goes back to the list.
5. When everyone in this sale has been added, close the check-in screen and take payment with **Pay on Verifone**.

If the booking is for another day, was cancelled, or was marked as a no-show, the screen says so and the button
reads **Check in anyway**. Only tap it if that's OK.

### Splitting the bill

Some people choose "Split the bill at the counter" when they book; the screen says **Splitting the bill**.

1. Check them in, then tap **Split the bill**.
2. Pick **One person's share** (the screen shows how many are left to pay and how much each) or **A different
   amount** and type it.
3. **Who's paying this share?** Tap the booker's name, tap **Scan their member code** (the code in their My Lair),
   or type their member code and tap **Find**. They go on the sale, so their spend earns *their* dice rolls. No
   member code? Go ahead anyway.
4. Tap **Add $X to cart**, close the check-in screen and take payment on the Verifone.
5. For the next friend, open the booking again (scan the booker's code, or find them in the list). It shows what's
   been paid and what's left. Right after a payment it may say **"Waiting for the last payment…"**: tap
   **Refresh** after a few seconds. If that payment didn't go through after all, tap **It wasn't paid**.

### A member code

Scanning someone's member code (from My Lair) shows their bookings today, their tab and their passes.

- **Check in everyone and add to cart** checks in all of their bookings today and adds what they owe. Once they're
  all here, the button just says **Add $X to cart**.
- **Tab:** drinks and snacks they added in My Lair. **Add tab to cart** puts them in the cart as the real products
  (the till charges the shop's own prices). Then take payment as usual.
- **Put Sam on this sale** makes their spend count toward their dice rolls.
- Tap a pass to see it.

### A session pass code

Scanning a pass shows who has it and how many sessions are left. Tap **Use on…**, then the booking it's for: that
person is checked in with the pass and the screen shows what's left to pay.

### Wrong pass?

After a check-in that used a pass, the person's screen shows the pass in use:

- **Undo pass** gives the session back, and the screen shows what's to pay now ("Pass undone. $45 to pay.").
- To use a different pass, pick it and tap **Switch to this pass**: the first one is undone, then they're checked in
  again with the new one.
- Pick **Don't use a pass** and tap **Check in again without a pass** to pay the full amount instead.

This works for someone checked in earlier too: open them again and the pass in use is there. If their fee is already
in the cart, take that line off the sale first. (The staff page can undo a pass as well, under Passes.)

### What the labels mean

| Label | Means |
| --- | --- |
| Here | Checked in |
| Paid | Already paid (online, or earlier) |
| Free | Nothing to pay (a free event, say) |
| Due $X | Still to pay |
| In cart | Its fee is in this sale, waiting for payment |
| Pass | They'll use their saved session pass |
| No-show | Marked as not coming |
| Refund? | They paid online, then cancelled or didn't come: sort out a refund on the staff page |

## One-time setup (Mo, on your phone)

Do steps 1 and 2 before this folder is merged into `main`: merging starts the first deploy, and without the key it
stops with a message saying the key is missing. If that happens, do steps 1 and 2, then step 4.

Use your phone's web browser (Safari or Chrome) for GitHub, not the GitHub app: the app can't add secrets.

### 1. Make a deploy key in the Shopify Dev Dashboard

1. Open https://dev.shopify.com/dashboard and log in.
2. Tap **Apps**, then **Dice Goblin Lair**, then **Settings**.
3. Scroll to **App Automation Token** and tap **Create token**.
4. Under **Expiration**, pick **6 months**, then tap **Generate token**.
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
| Scopes | `read_customers`, `read_metaobjects`, `read_themes`, `read_orders`, `write_draft_orders`, `write_store_credit_account_transactions`, `write_app_proxy`, `write_discounts` |
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

| The screen says | What to do |
| --- | --- |
| Can't reach the Lair app | Check the iPad's internet and tap **Try again**. If the internet works and it always says this, the Lair app may be missing its latest update. |
| This POS login has no access | Step 6 above, or log the POS in with the owner's account. |
| The Lair app didn't accept this POS login | Close the check-in screen and open it again. If it keeps happening, the Lair app's Shopify client ID or secret doesn't match this app. |
| Code not found | Check the code with them, or search by name. |
| That's not a Lair code | The scanner read something else, like a product barcode. |
| It isn't in the cart | Add it by hand as a custom sale, with the title and price shown. |
| It's in the cart, but not linked | After they pay, mark the booking paid on the staff page. |
| Already in the cart | That booking already has a line in this sale: take that payment first, or take the line off the sale. |
| Waiting for the last payment… | The payment hasn't reached the Lair app yet: tap **Refresh** in a few seconds. Didn't go through? Tap **It wasn't paid**. |
| Couldn't find that pass use | Undo it on the staff page, under Passes, then open them again here. |
| The tile says "App failed to load" | Close and reopen Shopify POS, and update it from the App Store. If it continues, note the device and iOS version and ask Claude. |

## What the Lair app (the Worker) does for this

The check-in screen talks to the Worker directly, at `https://dice-goblin-lair.dicegoblinnz.workers.dev/pos/…`, with
`Authorization: Bearer <POS session token>` (API contract v4, sections 7 and 11):

| Route | What for |
| --- | --- |
| `GET /pos/today` | Today's groups and everyone in them (the home screen, and the tile's numbers) |
| `POST /pos/scan { code }` | What a scanned or typed code is: a booking or sign-up, a member, or a pass |
| `POST /pos/checkin { id, type, pass?, force? }` | Check one person in; `pass` is a pass code, `'none'`, or left out for their saved pass. Answers with cart lines |
| `POST /pos/checkin-member { customerId }` | Check in everything a member has today, with cart lines |
| `POST /pos/share { id, type, amount? }` | One share of a bill as a cart line |
| `POST /pos/pass-undo { useId }` | Give a pass use back (the same as the staff page's undo); answers `{ pass, row }` |
| `POST /pos/tab/:id/added` | A member's tab is in the cart |

- The session token is a JWT signed HS256 with the app's client secret, `aud` = the client ID, `dest` =
  `https://ep0qiq-rp.myshopify.com`. Errors come back as `{ error: "Plain sentence" }` and the screen shows them.
- **CORS:** POS calls from Shopify's own origin, so `/pos/*` answers `OPTIONS` and allows `GET, POST`, the
  `Authorization` and `Content-Type` headers, and any origin. Without it, every scan says "Can't reach the Lair app".
- **Cart lines:** fees are custom sales carrying `_booking: <code>` (and `_share: '1'` for a share of a bill); tab
  items are the real products carrying `_tab: <tab id>`. When the POS order is paid, the orders/paid webhook records
  each `_booking` line as a payment towards that booking or sign-up and marks each `_tab` tab paid.
- **Passes:** a check-in that used a pass answers with its `pass.useId`, which **Undo pass** sends to
  `/pos/pass-undo`. For someone checked in earlier, the screen finds the use from the pass itself (`/pos/scan` of a
  pass code lists its `uses`). Switching undoes the pass in use first, then checks in again with the new choice (a
  pass code, or `'none'`). Asking for the cart lines again always sends `pass: 'none'`, so it never uses a pass by
  itself.

## For developers

```
cd pos-app
npm ci
npm test        # the logic: codes, the Today list, badges, passes, split bills, cart lines, Worker calls
npm run check   # type-checks the extension against the POS API types (2026-07)
npm run build   # bundles the extension (works offline, no Shopify login needed)
```

- POS UI extensions API `2026-07` (Preact with Polaris web components such as `s-button`), Shopify CLI 4.
- `extensions/lair-checkin/src`:
  - `Tile.jsx` (the home tile) and `Modal.jsx` (the check-in screen: state, scanning, and every call to the POS and
    the Worker); `views.jsx` draws the screens from what `Modal.jsx` hands it.
  - Plain modules with tests in `test/`: `codes.js` (reading codes), `format.js` (money, times in Auckland),
    `today.js` (the Today list, badges, search), `flow.js` (which screen next, pass choices, where a scan goes),
    `split.js` (shares of a bill), `lines.js` (cart lines and toasts), `cart.js` (the POS cart), `lair.js` (Worker
    calls and error banners), `store.js` (what the iPad remembers between visits).
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

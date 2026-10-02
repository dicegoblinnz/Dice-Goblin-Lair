# Lair check-in for Shopify POS

A tile on the Shopify POS home screen for the Dice Goblin counter. Staff scan what the customer shows them:

- **A ticket** (like `SAM-4821`): the screen shows who it is, what they booked and what's left to pay.
  **Add $40.00 to cart and check in** checks them in and puts the table fee in the POS cart, so staff take
  payment the usual way with **Pay on Verifone**. Once it's paid, the Lair app marks the booking paid by itself.
- **A member card** (`DGC-…`, the QR code in My Lair): puts that member on the sale, so what they spend counts
  toward their bonus dice rolls.

This folder is a Shopify app project: `shopify.app.toml` holds the app's settings and `extensions/lair-checkin` is
the tile. It talks to the Lair app (the Cloudflare Worker at the root of this repository) and changes nothing there.

## At the counter

1. On the POS home screen, tap **Lair check-in**.
2. Tap **Scan ticket or member card** and point the camera at the QR code. A barcode scanner works too, or type
   the code in the box and tap **Look up** (capitals and dashes don't matter: `sam4821` works).
3. For a ticket, check the name, then:
   - **Add $X to cart and check in**, close the check-in screen and take payment with **Pay on Verifone**, or
   - **Check in only** when there's nothing to pay.
   - Not for today, or cancelled? The screen says so. Only tap the button that ends in **anyway** if that's OK.
4. Tap **Scan next** for the next person.

If the booking belongs to a customer account, that customer goes on the sale too (unless the sale already has one).

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

Deploys run by themselves whenever a change under `pos-app/` lands on `main`. To run one by hand:

1. Open https://github.com/dicegoblinnz/Dice-Goblin-Lair/actions/workflows/pos-deploy.yml
2. Tap **Run workflow**, leave the branch on `main`, and tap **Run workflow** again.
3. After 2–3 minutes it shows a green tick. A red cross means it didn't deploy: tap the run, then the step with the
   cross, to read why. To retry a run, open it and tap **Re-run jobs**.

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
| Can't reach the Lair app, or No internet | Check the Wi-Fi and tap **Try again**. If the internet works and it always says this, the Lair app isn't letting POS in yet (see the next section). |
| This POS login has no access | Step 6 above, or log the POS in with the owner's account. |
| The Lair app didn't accept this POS login | Close the check-in screen and open it again. If it keeps happening, the Lair app's Shopify client ID or secret doesn't match this app. |
| Code not found | Check the code with the customer, or find them on the staff page. |
| That's not a Lair code | The scanner read something else, like a product barcode. |
| The fee isn't in the cart | Add it by hand as a custom sale, with the title and price shown. |
| The fee isn't linked to the booking | It's in the cart; after they pay, mark the booking paid on the staff page. |
| The tile says "App failed to load" | Close and reopen Shopify POS, and update it from the App Store. If it continues, note the device and iOS version and ask Claude. |

## What the Lair app (the Worker) must do for this

- **Routes** (API contract, section 6): `POST /pos/checkin { code, preview?, force? }` and `POST /pos/member { code }`,
  with `Authorization: Bearer <POS session token>`. The token is a JWT signed HS256 with the app's client secret,
  `aud` = the client ID, `dest` = `https://ep0qiq-rp.myshopify.com`. Errors as `{ error: "Plain sentence" }`
  (404 for an unknown code, 401 for a bad token); the screen shows the sentence.
- **CORS.** POS sends these requests from `https://cdn.shopify.com` and `https://extensions.shopifycdn.com`, with
  `Authorization` and `Content-Type: application/json` headers, so it asks first with `OPTIONS`. The Worker must
  answer `OPTIONS /pos/*` with 204 and `Access-Control-Allow-Origin` (that origin, or `*`),
  `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type, Accept`
  and `Access-Control-Max-Age: 86400`, and add `Access-Control-Allow-Origin` to every `/pos/*` answer, errors
  included. Without it, every scan says "Can't reach the Lair app".
- **`preview: true`** on `/pos/checkin`: look the code up without checking anyone in, with the same answer
  (`checkedIn: false` unless they're already in, `reason` as usual, plus `due`, `lines` and `customer`). The screen
  sends it when a code is scanned and checks in only when staff tap the button. A Worker that ignores `preview`
  checks people in as soon as they're scanned; the screen copes by showing "Checked in" and offering just
  **Add $X to cart**.

## For developers

```
cd pos-app
npm ci
npm test        # code reading, fee lines and labels
npm run check   # type-checks the extension against the POS API types
npm run build   # bundles the extension (works offline)
```

- POS UI extensions API `2026-07` (the latest stable version: Preact with Polaris web components such as
  `s-button`), Shopify CLI 4.
- `extensions/lair-checkin/src`: `Tile.jsx` (home tile), `Modal.jsx` (the check-in screen), `lair.js` (Worker calls),
  `cart.js` (POS cart), `codes.js` (reading codes, fee lines, labels). `shopify.d.ts` is generated by the CLI.
- `.github/workflows/pos-deploy.yml` (at the repository root) runs the tests, then
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

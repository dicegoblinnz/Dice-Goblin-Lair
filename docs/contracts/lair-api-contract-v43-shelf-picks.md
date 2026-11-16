# Lair API contract v43: the d20 roller's shelf list (round 43)

Mo, 17 November 2026: "the home page d20 roller should only pick things on the shelf right now (stock above 0). No
ordered-in Warhammer, pre-orders or dropshipped dice. It reads /collections/all/products.json, which can't tell them
apart, so give it an in-stock source."

Why the website can't tell: a variant's stock on the storefront is every location's count together. A dropshipped dice
set shows 100 (the dice maker's count, at the "Dice Hoard" location, with 0 at the shop), and Games Workshop's ordered-in
kits and anything on pre-order keep selling at 0 ("continue selling when out of stock"), so all of them look available.
Only the count at the shop's own location, "Dice Goblin" (`stockOffLocation`, the one Stock off takes from), says what's
on the shelf, and only the Admin API reads one location's count.

## 1. What's on the shelf

A variant is on the shelf when all of these are true (`shelfRowOf`, `src/shopify.js`):

- Shopify counts it (tracked);
- its **available** count at the shop's location is above 0 (on hand, less what's already sold or set aside), so a
  dropshipped set (0 at the shop), an ordered-in kit (0 or below) and a pre-order (0) never are;
- its price is over $0;
- its product is active, on the Online Store, and something the shop sells: never a gift card, a library copy (tag
  `Board Game Rental`, "(Library)" in its title or `board-game-rental` in its handle), a membership, a product tagged
  `hidden` or a dice-chest prize (`dice-chest-prize`). The theme checks the same again.

## 2. GET /proxy/shelf/pick

Anyone, logged in or not; nobody is looked up. `?not=` lists product numbers to skip (comma-separated, numbers only, the
first 10): the roller sends the last few it showed.

→ `{ pick: { productId, handle, variants } | null, count, at }`

- `pick`: one product from the list, every product equally likely (not every variant), with `variants` its variant
  numbers on the shelf (numbers as text). The theme reads the product's own page data (`/products/<handle>.js`) for
  its title, picture and today's price, and only offers a variant from `variants`.
- `count`: how many products the list holds (0 when there's no usable list).
- `at`: when the list was read (ISO), or null.
- `pick` is null when there's no usable list yet, the list is older than two hours, or nothing is on it but what was
  skipped. The roller then makes its own careful pick (the theme's side: only things Shopify counts that stop selling
  at 0 and have stock), so it never guesses.

## 3. Keeping the list

- The list lives in the Lair (`shelf_stock`, `shelf_runs`). A pick from a list older than **20 minutes** (or no list)
  starts a fresh read in the background; the pick itself answers at once from the list it has.
- A read asks Shopify for every variant with stock anywhere (`inventory_quantity:>0`, active products), 150 a page, each
  with its count at the shop's location, paced by Shopify's query bucket (a throttled page waits and is asked again, up
  to 3 times in a row).
- One read at a time. A read uses at most **20** Shopify calls an invocation, counting the request's own (Cloudflare's
  free plan allows 50); what's left carries on from the same page with the next pick, unless it last moved more than 10
  minutes ago, when a fresh read starts.
- The new list replaces the old only once its last page is read, so a pick never sees half a list.
- A read that fails keeps the old list, and the next read waits **5 minutes**.
- A list older than **2 hours** isn't picked from (see 2).

## 4. Checks

`test/round43-shelf-picks.test.js`, each named for the rule it checks.

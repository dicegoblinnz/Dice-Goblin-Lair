# Lair app API: round 16, the wishlist [wishlist] (16 Oct 2026)

**Changes only**, on top of v15-tab and everything before it; where they disagree, this file wins. Times in ms (UTC).
Errors stay `{ error: "A plain sentence." }` with a 4xx. Backend branch `r16-main`. No theme branch: nothing in the
theme shows the wishlist yet, and the Add to wishlist button stays switched off until Mo says.

Mo (16 Oct): "Add to wishlist should be done later for now just build the infrastructure."

So this round is the Lair app's half only: where a member's wishlist is kept, and three routes to read and change it.
There are no emails, nothing new on `GET /me`, and the Lair never asks Shopify about the products. When the button goes
on, a product page sends its `product.id`, `product.handle` and `product.title`.

## 1. Rules

- **Members only.** A logged-in member keeps one wishlist of Shopify products. A guest gets what every `/me` route
  gives a guest: a `401` with a "Log in to …" sentence (`login` below). A member only ever sees and changes their own,
  and staff have no special view: they reach their own list like anyone, and a `customerId` sent anywhere is ignored.
- **One row per member per product**, in the new table `wishlist` (`customer_id`, `product_id`, `handle`, `title`,
  `created_at`; primary key `customer_id` + `product_id`), made when the Lair starts if it isn't there yet.
- **The product** (`productId`) is its Shopify number, sent as a whole number (`8123456789012`), a string of digits
  (`"8123456789012"`) or its GID (`"gid://shopify/Product/8123456789012"`). All three are kept as the digits (1 to 20 of
  them), so they're the same product. Anything else is `422 product`: another kind of GID (a variant's), letters, a
  fraction, below zero, or a number too big to be read exactly (over 9007199254740991: send it as a string).
- **What the page sends with it**, both optional and kept as sent, for showing the list:
  - `handle`: lowercase letters, digits and hyphens, at most 255 (spaces around it are trimmed). Otherwise
    `422 handle`.
  - `title`: text, trimmed, each run of white space (spaces, tabs, new lines) made one space, then at most 255
    characters (an emoji counts as one). Otherwise `422 title`.
  - Left out, `null` or empty: none.
- **At most 100 products a member.** Adding a new one when there are 100 already is `409 full`. Adding one that's
  already on the list is never refused for this.
- **Adding one again** keeps when it was first added (and so its place in the list), and takes the `handle` and `title`
  when they're sent; left out or empty, the kept ones stay. The answer says `added: false`.
- **Taking one off** that isn't on the list is fine (`removed: false`), never an error. One taken off and added again
  later is new: its `addedAt` is when it came back.

## 2. Routes

All three need a logged-in member (through the app proxy: `www.dicegoblin.nz/apps/liar/me/wishlist…`).

An item is `{ productId, handle, title, addedAt }`: `productId` the product's digits as a string, `handle` and `title`
what was kept (`''` when the page never sent one), `addedAt` when it was first added (ms). `items` is the member's
whole list, newest first (two added in the same millisecond: the later one first).

### 2.1 `GET /me/wishlist`

→ `{ items }`. Errors: `401 login`.

### 2.2 `POST /me/wishlist { productId, handle?, title? }`

Adds it. → `{ ok: true, added, items }`: `added` is `true` for a new one, `false` when it was on the list already.
Errors, checked in this order: `401 login`; `422 product`; `422 handle`; `422 title`; `409 full`. Nothing is written
when it's refused.

### 2.3 `POST /me/wishlist/remove { productId }`

Takes it off. → `{ ok: true, removed, items }`: `removed` is `false` when it wasn't on the list. Errors: `401 login`;
`422 product`.

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `login` | Log in to keep a wishlist. |
| `product` | That doesn't look like one of our products. Refresh the page and try again. |
| `handle` | That product's link doesn't look right. Refresh the page and try again. |
| `title` | That product's title doesn't look right. Keep it to 255 characters. |
| `full` | Your wishlist is full (100 games). Take one off to add another. |

(`WISHLIST_MESSAGES` in `src/wishlist.js`. 100 is `WISHLIST_MAX` and 255 is `WISHLIST_TEXT_MAX`.)

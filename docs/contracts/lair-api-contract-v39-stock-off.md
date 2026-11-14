# Lair API contract v39: Stock off

Round 39. Mo (15 Nov 2026): "i want to build a special staff function [...] that gives staff view an option to do, where
it gives me the use of my camera and scan my items to then click a button to decrease the quantity of that item by the
amount scanned. meaning i will take products with me to conventions and instead of doing stock take after i come back i
instead scan each item and click a button to take the stock off from the website and all that jazz. i want this to be a
relatively quick and easy way to handle so it doesnt slow me up during markets but it will keep the stock clean it would
be cool to add a button to say that item is not sold so it doesnt count as a sold itme and just taken off stock for what
ever reason like damage maybe gift etc."

His picks the same morning, each from a question with its options spelled out:

- What Sold records: **"Stock off only"** ("No prices and no order. Stock just drops, marked as sold at that event, and
  convention money stays outside Shopify as it does now.")
- Dice: **"Leave dice out"** ("The scanner only handles stock with barcodes. Dice carry on as they do now.") Asked
  because Dice Goblin's own dice aren't counted one design at a time: on 15 Nov 2026 all 148 named sets showed 0 at the
  shop (their 100 is the dice maker's, at the Dice Hoard location) and the shop rings dice up on the $10 to $90 Dice keys.
- Not sold: **"Any staff, I get a list"** ("Anyone on the team picks a reason. It's saved under their name, and every
  one is in the summary you get after the event.")
- Needed: **"Within a week"**, so this round is the core: scan, Sold, Not sold, undo, the list.

New: `src/stock-off.js`, its calls in `src/shopify.js`, its routes, tables and line in the 10-minute run in
`src/lair.js`; tests `test/round39-stock-off.test.js`; the website's side is section 7.

## 1. The rules

- **A lot.** One tap of Sold or Not sold on the website's Stock off page: the things scanned, each with how many
  (1 to 99, up to 40 different things). It carries where it was (`event`: "Armageddon Auckland", or empty for the
  shop itself), what happened (`outcome`: `sold` or `not-sold`) and, when it's not sold, why (`reason`: `damaged`,
  `gift`, `prize`, `lost` or `other`, and `other` needs a few words in `note`).
- **Only the count changes.** A lot takes its things off the shop's own count in Shopify (the location "Dice Goblin";
  `STOCK_OFF_LOCATION_ID` can name another), whether it's sold or not. No order is made, no price is kept and no
  customer is involved. Sold or not, and the event, are the Lair's own record: Shopify has no "sold" reason for a
  change to a count.
- **Never below zero.** What comes off a thing is how many were scanned or the shop's count, whichever is smaller; a
  count at or under zero gives nothing. The rest is the line's `short`: the count was already wrong before the scan,
  so the list says so and nothing goes negative. (A count under zero is a thing ordered in or oversold; it's left
  exactly as it is.)
- **What can't come off**, each refused with its own words (section 5):
  - a library copy (its title says "(Library)", or the code scanned is a shelf code the Lair knows);
  - a gift card;
  - Dice Goblin's own dice: anything in the dice deal's collection whose vendor is `Dice Goblin NZ` (the Dice price
    keys and the named sets). Other makers' dice are counted stock and come off like anything else;
  - anything Shopify doesn't count (its Track quantity is off: the drinks, the ice creams);
  - anything with no count at the shop's location.
- **All or nothing.** A lot with a thing that can't come off is refused whole, saying which, and nothing changes.
- **Once.** A lot has the phone's own key (`id`). The same lot again, however often and however late, answers as it
  did the first time and takes nothing more off. The same key with different things in it is refused.
- **Undo.** Any staff can take a lot back within 24 hours of it coming off: exactly what it took goes back on the
  count, once.
- **Who.** Anyone the staff page lets in: the owner or a helper, whatever their permissions. Every lot and every undo
  keeps their first name.
- **The owner's list.** Each morning from 8am at the shop, one email to the shop's owner with every lot of the days
  before that hasn't been in one yet (section 6). Nothing goes to the team's address.

## 2. Routes

All through the shop's app proxy (`www.dicegoblin.nz/apps/liar/…`), all for staff: 401 with nobody logged in, 403 for
a customer who isn't on the team.

| Route | What |
|---|---|
| `GET /proxy/stock` | The page's start: `{ staff: { name, role }, day, undoHours: 24, reasons: [{ key, label }], events: [recent names] }`. `events`: the places lots were taken off in the last 90 days, newest first, up to 8, never the empty one. `day`: the shop's day now (`YYYY-MM-DD`, Auckland). |
| `POST /proxy/stock/product` | `{ code }`: a barcode in any of its forms, or a SKU → `{ product, variant }`, with `choices: [{ product, variant }]` when several things that can come off share it (the page asks which; `product` and `variant` are the first of them). `product`: `{ id, title, vendor, type, status }`; `variant`: `{ id, title, sku, stock }` (`title` is `Default Title` for a product with no options; `stock`: the shop's own count now, which can be 0 or less). Shopify's answers for a code are kept for a minute. |
| `POST /proxy/stock/off` | `{ id, event?, outcome, reason?, note?, at?, lines: [{ variantId, qty }] }` → `{ lot }` (section 3). `id`: `so-` and 32 hex digits, made on the phone for each tap. `at`: the phone's clock when the button was tapped, in ms; it's believed when it's within the last 7 days and no more than 5 minutes ahead, otherwise the Lair's own clock is the lot's time. `event`: up to 60 characters, trimmed; a lot with none is the shop's. `note`: up to 200 characters. The same `variantId` twice is a 400. |
| `POST /proxy/stock/undo` | `{ id }` → `{ lot }` with `undone` set. A second undo answers the same and puts nothing more back. |
| `GET /proxy/stock/log?day=YYYY-MM-DD` | `{ day, lots, totals: { lots, sold, notSold, short } }`: that day's lots that have come off (today's when `day` is left out; any of the last 60 days), newest first. `totals` leave out lots taken back: `lots` is how many there were, `sold` and `notSold` how many things were scanned in them (what left the stall, whatever the count had) and `short` how many of those weren't on the count. |

## 3. A lot, as the Lair answers it

```json
{
  "id": "so-0f3c…",
  "event": "Armageddon Auckland",
  "outcome": "not-sold",
  "reason": "damaged",
  "reasonLabel": "Damaged",
  "note": "Box crushed in the van",
  "by": "Caleb",
  "at": 1795152000000,
  "day": "2026-11-21",
  "units": 3,
  "took": 2,
  "short": 1,
  "lines": [
    { "variantId": "456", "title": "Wingspan", "qty": 2, "took": 1, "short": 1, "left": 0 },
    { "variantId": "789", "title": "Dragon Shield Matte Sleeves · Jet", "qty": 1, "took": 1, "short": 0, "left": 4 }
  ],
  "undone": null
}
```

`lines` are in the order the things were scanned. `title` is the product's, with the option after a `·` when it has
one. `units` is how many were scanned, `took` how many came off the count and `short` the difference. `left` is the
shop's count once the lot had come off. `undone` is `null`, or `{ at, by }` once it's been taken back. `reason`, `reasonLabel` and `note` are `null` on a
sold lot.

## 4. In Shopify

One `inventoryAdjustQuantities` a lot (`name: available`, at the shop's location), every line in it, so a lot comes off
together or not at all:

- each line's change carries the count it was read at (`changeFromQuantity`). If a count moved in between (a sale
  online, another phone), Shopify refuses the lot and nothing changes: the Lair reads the counts again and tries again,
  up to 3 times, so the never-below-zero rule holds against what the count really is;
- Shopify's idempotency key is the lot's own (`@idempotent`), so an answer lost on the way is asked for again and never
  taken off twice. A lot whose answer never came is not sent again once the key's 24 hours are nearly up (23 hours):
  it says to check Shopify;
- `reason`: `other` for sold; `damaged`; `promotion` for a gift or a prize; `shrinkage` for lost; `other` for other. If
  Shopify turns a reason away, the lot is sent once more as `other`;
- `referenceDocumentUri`: `gid://dice-goblin-lair/StockOff/<id>`, so the count's history in Shopify admin names the
  Lair app;
- an undo is the same call with the amounts put back (`reason: correction`, its own key, no `changeFromQuantity`).

A lot where nothing could come off (every count at zero) makes no call to Shopify and is kept, with its `short`.

Needs `read_products`, `read_inventory` and `write_inventory`, all approved already.

## 5. Words, word for word

Looking a code up (`POST /stock/product`):

- 400 `That doesn't look like a barcode. Scan it again, or type the numbers under it.`
- 404 `Gobgob can't find that barcode in the shop.`
- 422 `That's a library copy, not shop stock, so there's nothing to take off.`
- 422 `Gift cards aren't counted stock.`
- 422 `Dice Goblin's own dice aren't counted one by one, so leave them out.`
- 422 `Shopify doesn't count Can of Drink, so there's nothing to take off.`
- 422 `Catan has no count at the shop in Shopify.`
- 503 `Shopify didn't answer. Try again in a moment.`

When several things share a code, the ones that can't come off are left out of `choices`; with none left, the first
one's words are the answer.

Taking a lot off (`POST /stock/off`):

- 400 `That lot's details didn't come through. Try again.` (no `id`, or not one of ours)
- 400 `Choose Sold or Not sold.`
- 400 `Choose why it isn't sold.`
- 400 `Say what happened in a few words, so the list makes sense later.` (`other` with a note under 3 letters)
- 400 `Scan at least one thing, and up to 40 different things a lot.`
- 400 `Each thing needs a count from 1 to 99, once a lot.`
- 409 `That lot was already sent with different things in it. Start a new one.`
- 409 `That lot may already be off the count. Check it in Shopify, then start a new one.`
- 422 `Some of that lot can't come off the count. Take those out and send it again.` with
  `problems: [{ variantId, words }]`, each thing's own words from the list above (`Gobgob can't find that in the shop any more.`
  for one Shopify no longer has)
- 422 `Shopify said no: <its words>`
- 503 `Still taking the last lot off. Wait a moment, then try again.`
- 503 `Shopify didn't answer. Try again: nothing comes off twice.`
- 503 `The shop's count kept changing while that lot was coming off. Try again.`

Taking one back (`POST /stock/undo`):

- 404 `Gobgob can't find that lot.`
- 409 `That lot hasn't come off yet, so there's nothing to put back.`
- 409 `That lot came off more than a day ago. Fix the count in Shopify instead.`
- 409 `That lot may already be back on the count. Check it in Shopify.` (an undo whose answer never came, 23 hours on)
- 503 `Shopify didn't answer. Try again: nothing goes back twice.`

The list (`GET /stock/log`): 400 `Pick a day from the last 60 days.`

Staff: 401 `Log in with your staff account to use Stock off.`; 403 `Stock off is for the Dice Goblin team.`

Reasons, as `GET /stock` lists them: `damaged` Damaged, `gift` Gift or giveaway, `prize` Prize, `lost` Lost or
stolen, `other` Something else.

## 6. The owner's list

The 10-minute run, from 8am at the shop: every lot that has come off (or been taken back), on a day before today, that
hasn't been in a list yet, goes in one email to the owner. A lot the Lair only heard about late (a phone with no signal
at the hall) is in the next morning's.

- **To:** `STOCK_OFF_EMAIL` when it's set (one address, or `off` for no email at all), otherwise the shop owner's own
  address as Shopify has it (Settings, Store details). Never `STAFF_EMAIL`. Not in `wrangler.toml` (this repo is
  public).
- **Subject:** `Stock off, Saturday 21 November: 46 sold, 3 not sold`; over several days,
  `Stock off, 21 to 22 November: 80 sold, 3 not sold`.
- **It says**, for each day and each place (`At the shop` for a lot with none): what sold, added up by thing
  (`12 × Catan`), most first, and who scanned; each thing not sold on a line of its own with its reason, who and
  when, and the note (`1 × Wingspan: damaged (Caleb, 2:14 pm). Box crushed in the van`); what was scanned and wasn't
  on the count (`Wingspan: 2 scanned, 1 on the count`), as counts to check; and lots taken back, with who took them
  back. Its numbers are what was scanned: what left the stall, whatever the count had.
- **One a morning.** A lot that turns up after that morning's list has been written waits for the next morning's.
  Lots that were all taken back make no email.
- **A lot is in one list.** One taken back after its list was written isn't in a later list: the count is put right
  in Shopify and the page's list says who took it back, and the email already sent stays as it was. (The page offers
  Undo straight after the tap and in today's list, both before the lot's list is written. Found by the separate
  review, 15 Nov 2026, and left as it is.)
- **Once.** The email is written once and kept with its key, so a try that may have gone is never followed by a second,
  different one. A try that fails is tried again by each run for 23 hours, then given up on (the status table's
  `stockOff` says why). The lots are on the page's list either way.

## 7. The website's side

The theme (`dicegoblinnz/Dice-Goblin-website`): the staff page with `?view=stock` on the end
(`templates/page.stock.json`, `sections/lair-stock.liquid`, `assets/lair-stock.js` and `lair-stock.css`), and a link to
it on the staff page for staff. Its checks: `tools/qa/round39-stock-off/`.

- **One screen, for a phone.** The camera stays on at the top, the lot being scanned is under it, and Sold and Not
  sold are at the bottom. A scan adds one; the same thing again adds another once the camera has lost sight of it, and
  each line has its own minus and plus. Only a barcode inside the frame counts, and of those the one nearest its
  middle. Sold is one tap, with Undo offered straight after. Not sold asks why first. A hand scanner that types the
  numbers and presses Enter works too, and so does typing them.
- **Where you are** is asked once a day and remembered on the phone, with the last places a tap away.
- **Slow or no signal.** The page is up and scanning before the Lair app has answered. A lot is saved on the phone
  the moment its button is tapped, and sent when the Lair can be reached, in the order they were tapped: the same key
  every time, so it never comes off twice. A scan that couldn't be looked up is looked up before its lot is sent; one
  that turns out to be a thing that can't come off holds its lot back and says so. With no connection at all (the
  phone says so itself) nothing is tried.
- **Undo, whatever the signal.** A lot that never left the phone is forgotten. Any other may be off the count
  whatever the phone heard back, so it's sent (again, under its key) and then taken back with `POST /stock/undo`,
  before any lot tapped after it. A lot taken back while its scans are still being looked up is never sent.
- **A lot the Lair refuses** is held, with the Lair's words on the things that can't come off, and can be sent without
  them (under a new key), put back on the list or dropped. One the Lair answers 409 for may already be off the count:
  the page never says it hasn't come off, and its two ways out say what each means (it's off: forget it; it isn't:
  back on the list), for someone who has looked in Shopify.
- **More than one tab of the page on a phone.** Each sends what the others left waiting, so nothing is lost when one
  is closed, and a lot one of them has finished with or taken back is finished for all (the phone keeps their keys
  for 8 days).
- **The section's Stock setting.** Practice (the default): everything works and nothing is saved or taken off, on
  the shop's real products where the Lair app answers and on made-up ones otherwise (the lab with nobody logged in,
  which says so). Live: lots come off in Shopify. With the booking system on Demo (the lab) it's always practice, and
  a page on made-up things never sends a lot, even one the live page left waiting on the same phone.
- **Before this round is live in the Lair app**, a practice page looks codes up through the till's
  `POST /proxy/till/product`, so the lab can be tried on the shop's real barcodes.

# Lair app API: round 5 (4 Oct 2026)

**Changes only.** This round sits on top of `lair-api-contract-v4.md` (same folder, sections 0–11), and v3 and the base contract still hold beneath that. Where they disagree, this file wins.

**Where things live (all deployed):**
- Backend: `main` of dicegoblinnz/dice-goblin-lair (local clone at /home/claude/dice-goblin-lair, at 11c0130 or later).
- Theme: branch `dice-goblin-2-theme` (local at /home/claude/dg-theme, b357cf9).
- Preview theme: 166589005927.

## 1. Session passes are a product
**Store setup (done by the coordinator, still a draft):** product "Session pass", handle `session-pass`, id 10237298278503.

| Variant | Price | SKU and barcode | Variant id |
|---|---|---|---|
| "10 sessions" | $100 | `LAIR-PASS-10` | 50371432939623 |
| "5 sessions" | $50 | `LAIR-PASS-5` | 50371432972391 |

No shipping, not tracked.

**orders/paid webhook (backend):**
- A paid line whose `sku` matches `/^LAIR-PASS-(\d{1,3})$/i` issues `quantity` passes, each of N sessions, where N is from the SKU. Online and POS orders both count.
  - `label`: "Session pass: N sessions".
  - `cover`: `rules.prices.table`.
  - `pricePaid`: the line's net amount (after its discount allocations) ÷ quantity.
  - `source: 'order'`, plus `orderName` (like "#1550").
- **Holder:** the order's customer (linked: customerId, name, email).
  - With no customer, the pass is unlinked. The holder name comes from the order's billing or shipping name when there is one, otherwise "Sold at the counter".
- **Idempotent:** one pass per (order id, line id, unit index). A repeated webhook issues nothing new.
- **Pass view (all routes):**
  - adds `source: 'staff'|'order'|'birthday'` and `orderName`
  - `note` defaults to "Bought online" or "Bought at the counter"
- **My Lair:** the passes list shows these passes as usual.
- **Staff page Passes tab:** shows the source. Unlinked passes say "No customer on the sale: give them this code, they can claim it in My Lair".

## 2. One bill at the counter: sessions, owed sessions and the tab together
**GET /me** adds `dueNow`: everything they can pay at the counter now. This is:
- today's bookings, seats and joins with `due > 0`
- owed weekly-regular seats (section 3)

Each item is `{ id, type: 'booking'|'join', ref, title, start, end, amount, covered, paidAmount, due, owed: bool }`.

The tab itself is unchanged. The theme shows sessions and owed seats in the My Lair tab card above the snacks, with one combined total and the member code QR ("Show your code at the counter to pay everything").

**POS member scan** (`/pos/scan` member, and `/pos/checkin-member`):
- `rows` also include their owed rows (with `owed: true`, earlier dates, not checked in).
- `/pos/checkin-member` doesn't check in owed rows. Their lines are added under the title "Owed: <title> (<date>)".
- The POS member view's main button is "Add everything to cart ($X)". It does all of this:
  1. Check in today's rows.
  2. Add their lines, plus owed lines.
  3. Add the tab's items (`_tab`).
  4. Set the customer.
  5. Mark the tab added.

## 3. Weekly regulars ("join every session")
**Join a series:** `POST /games/:id/join-series` saves the membership, as before. It now books a seat **only in the next session** of that series that hasn't ended. There are no seats in later sessions.

**Rolling forward:** after a session ends, maintenance (the existing cron run every 10 minutes) gives each active series member a seat in the series' next session.
- This happens if the next session exists and still has room. If it's full, staff get an alert email.
- Those seats are linked to the member (`seriesId`, `customerId`).

**Holding regulars' seats:** for any series session, the seats left for everyone else = seats − booked seats − active members who don't yet have a booking in that session.

**Public games board (floor `games`):** a series shows only its next session that hasn't ended. Later sessions are hidden from the public board. GMs, staff and the game's own management views still see every session.
- Each game view gains:
  - `series: { id, schedule: 'weekly'|'fortnightly'|'flexible', regulars: n }`
  - `nextOnly: true` when it's the series' next session

**Ticket:**
- A series seat's ticket and QR are the member's card code (`member.code`), not the seat's own ref.
- Seat views add `ticketCode` (the member code for series seats, the seat's ref otherwise).
- Check-in by member code already finds today's seat (v4).
- The seat still keeps its internal `ref`, for `_booking` on POS lines.

**Owed:** a series seat whose session has ended unpaid becomes owed, whether or not they came.
- `owed: true` on the row, with `due` still due.
- It shows in My Lair (`dueNow`), the POS member view, and the staff Members view.
- Staff can waive it with `POST /bookings/:id/update { waived: true }`. This sets `due: 0` and `waived: true`, and the row is no longer owed.
- One-off (non-series) bookings keep the v4 rule: unpaid no-shows are just recorded, never owed.
- Paying an owed row works like any `_booking` line. An owed row can be paid at any later visit.

**My Lair:** a series shows a single card: the next session, a "Weekly" note ("Your seat's saved every week"), the member code as the ticket, and a leave option. It doesn't list every future session.

## 4. Staff Members view
`GET /members?q=&sort=spend|recent|owing&owing=1` (staff).
- Each member:

  ```
  {
    customerId, name, email, code, birthday,
    spendYear, spendTotal, lastSeen,
    owed,            // cents, owed series seats
    owedCount,
    openTab,         // cents: items on an unpaid tab from an earlier day, or today's open tab
    pendingPrizes,
    giftedThisYear   // bool
  }
  ```

- `owing=1` lists only members with `owed + openTab > 0`.
- With no `q`, it returns the top 100 by `sort`.

## 5. Birthday gifts (staff choose)
**`POST /members/:customerId/gift`** (staff) takes:

```
{
  credit?: dollars,
  sessions?: n (1–20),
  rolls?: n (1–20),
  productVariantId?: digits, productTitle?: string,
  note?: string,
  notify?: true
}
```

Any combination works, but at least one gift is needed.
- `credit`: `storeCreditAccountCredit`, as for dice.
- `sessions`: a pass labelled "Birthday gift: N sessions", `source: 'birthday'`, linked to them.
- `rolls`: that many extra dice rolls on their account. They're added to `rolls.available` and never expire.
- `productVariantId`: a one-use, 100%-off discount code for that one product variant, only for that customer, valid for 30 days. Use `discountCodeBasicCreate` with `customerSelection.customers` and `items.products.productVariantsToAdd`. The code reads like `HBD-<member code without dashes>`, made unique.
- `notify`: an HTML email, "Happy birthday from Gobgob!", listing every gift (with the product code). Use the existing email template system. This is a new email kind, and Mo asked for it.
- **Returns:** `{ gift: { id, at, credit, sessions, passCode, rolls, product: { title, code } | null, emailed, problems: [] } }`. A part that fails (no permission, for example) goes in `problems`, and the other parts still go through.

**`GET /members/birthdays`** (staff): the next 30 days. Each member adds:
- `suggested: { low, high }`, in dollars: 2% and 5% of the last 12 months' spend, rounded to the dollar, with a minimum of $2 each
- `giftedThisYear`
- `lastGift`

**The daily birthday job:**
- No longer makes discount codes automatically.
- Emails staff a summary of birthdays in the next 7 days, with each person's suggested range and a link to the staff page's Members tab. Send it once per day, only when there's at least one birthday.

**GET /me** adds `gifts`: this year's gifts, each `{ at, credit, sessions, rolls, product: { title, code } | null }`.

## 6. Game pictures by staff
`POST /games/:id/image` accepts staff for any game (not only its GM). The staff page's "Create a game for a GM" and "Edit game" forms get the same picture picker as the GM's own form: upload, then scale and move to frame it. They upload after saving the game.

## 7. Gobgob's quotes (theme only)
On My Lair, the quote bubble picks a random quote on load. The automatic rotation and "tap for another" each move to another random quote, never the same one twice in a row. The number badge shows that quote's number (1–20).

## 8. What the coordinator does
- Store data: the pass product (draft now; activated and published once the backend is live), library barcodes, metaobjects.
- Merging, deploying and theme uploads.

Agents must not:
- write to the store
- push
- upload theme files
- call the live Worker

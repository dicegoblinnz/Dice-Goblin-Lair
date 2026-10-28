# Lair API contract v22-stamps: stamps that follow payment, sessions rung up by hand, stamps staff add, and card payments at the counter

Round 22 (28 Oct 2026). From Mo, 28 Oct 2026:

- "When someone pays for his sessions it doesn't add a new stamp and issue is that the stamp is not clear."
- "I want to make each session for DND sessions or table session added manually should be added as well."
- "When you scan the QR code it adds the person as a customer to make sure they are added and everything applies. Make
  it as seemless as possible inside the POS Shopify app and the back end as well."
- "Give the staff to add a stamp on the area for the stamps." Then: "Also have the staff have the power to give stamps
  to members etc."

The code: `src/stamps.js` (the stamp ledger, the paid rule and the stamp routes), `src/counter.js` (counter sales
through Pay on Verifone), with changes in `src/lair.js` (the stamp count, `ordersPaid`, the counter's cart line titles,
the routes), `src/gm-credit.js` (a GM's own paid seat), `src/tab.js` (an account tab's cart line) and `src/index.js`
(the POS routes). The counter tile: `pos-app/extensions/lair-checkin/src/` (loyalty.js, cart.js, flow.js, lair.js,
lines.js, Modal.jsx, views.jsx). The staff page: the theme's `assets/lair-staff.js`, `lair-core.js`, `lair-demo.js` and
`lair-staff.css`. Tests: `test/round22-stamps.test.js`, `test/round22-counter.test.js`, `pos-app/test/*.test.mjs`, and
the browser check `tools/qa/round22/staff-stamps.mjs`.

## What was wrong

Two things, one under the other.

1. **A session only stamped once it was checked in.** A session paid but never scanned in (an owed seat paid at a later
   visit, several paid at once, a bill paid online) never stamped, and the Session product rung up by hand at the
   counter never stamped anyone.
2. **Card payments at the counter never reached the Lair.** Cards are taken with Pay on Verifone, and its app
   ("OrderMate: Reconcile Orders") saves each sale as an order of its own: `source_name` is its app ID `36219584513`,
   it's tagged `OrderMate` and `Verifone`, and it **drops the line properties** the Lair tile put on the cart's lines
   (`_booking`, `_share`, `_tab`). The Lair only read `source_name: 'pos'` orders, by those properties. So a session paid
   by card stayed unpaid in the Lair: once over, it was owed (on 28 Oct, #1996 paid Barons for 18 and 25 Oct by card,
   and three minutes later #1997 took the same two sessions as $30 cash), and a tab paid by card stayed at the counter.
   Only sales finished in Shopify POS itself (`source_name: 'pos'`, the last on 18 Oct) linked up.

## 1. Which sessions stamp

A table booking, game table, TTRPG seat or event sign-up stamps **once it's checked in, or once it's paid in full and
its day has come** (Lair time):

- checked in: a booking `seated` or `done`, a sign-up `attended`, as before;
- paid: `paid = 1` and still `confirmed`, from midnight (Auckland) on the day it starts. Paid ahead for a later date, its
  stamps land on that day. Part paid waits until it's all paid (or they're checked in);
- no-shows, cancellations and holds never stamp. Nothing is stored: a session cancelled or marked a no-show afterwards
  takes its stamps back, and one both paid and checked in stamps once;
- a sign-up or game table on an event date that's gone from the calendar (deleted, moved or skipped in Shopify) stamps
  only if they were checked in: paid alone, the event may not have happened (after the review).

`bookingStamps(alias)` and `joinStamps(alias)` in `src/stamps.js` are the one place that says this (one bound value:
when today ends); the card, its list of stamped sessions and a GM's own-session stamp (`GM_STAMP_ROWS`) all read them.

**No account on it.** A session nobody's account is on (a guest's, a walk-in, one staff made) stamps whoever paid for
it: the customer on its first payment that had one (`payments.customer_id`), as if they'd booked it. Scanning someone's
code at the counter before they pay is what puts them on the sale (section 5). Once the session joins an account (a
guest logs in with its email), it's that account's. A GM who pays a guest's seat in a session they run gets no stamp
for it: the session's own stamp is theirs already (after the review).

## 2. The stamp ledger

Stamps that don't come from a Lair booking are rows in `loyalty_stamps` (made when missing):

| Column | |
|---|---|
| `id` | `st_…` |
| `customer_id` | whose card |
| `kind` | `'sale'` (a session product rung up) or `'staff'` (added by hand) |
| `count` | stamps on the row (a sale's row is one unit: 1) |
| `title`, `note` | what My Lair and the staff page call it; a note for staff |
| `order_id`, `order_name`, `line_id`, `unit` | a sale's order line and unit (unique together: Shopify sending the order again adds nothing) |
| `key` | a request's own key (unique): the same key again gives back the first row and adds nothing |
| `at`, `created_by`, `created_at` | when; who (`staff:<customer id>`, `pos:…`, `order:#1234`) |
| `undone_at`, `undone_by` | Undo: the row stays for the record and stops counting |

Every row not undone counts on the card like a session (`stampRowsQuery`), and shows in My Lair's recent stamps as
`{ at, title, people: count }`: a sale as its session's name ("RPG Session", "Dice Goblin Day Pass"), a staff stamp as
"A stamp from Gobgob".

## 3. Session products rung up by hand

A line whose **SKU is `LAIR-SESSION` or starts `LAIR-SESSION-`** (`STAMPS.sessionSku`, any case) on a paid counter sale
(section 6) is a session: one stamp a unit (up to 10 a line), for the sale's customer, once per order, line and unit.
Its title is the variant's name when it has letters (not "Default Title"), else the product's. A sale with nobody on it
stamps nobody. Online orders never count.

**One session, one stamp (after the review).** Staff often ring up a Session for a session the Lair already has (a
booked table, a TTRPG seat), so a day's Session products and that day's Lair sessions are taken to be the same
sessions: the day counts whichever has more stamps, whichever came first. A Day Pass rung up for a checked-in table
is one stamp; a second Day Pass that day is a second stamp. The covered sale rows drop out of My Lair's list. Stamps
staff add by hand are never covered. (It's worked out every time, in `stampTally`.)

The store's session products had no SKUs on 28 Oct 2026. To go live they get:

| Product | Variant | Price | SKU |
|---|---|---|---|
| Session | Dice Goblin Day Pass | $10 | `LAIR-SESSION-DAY` |
| Session | TCG League | $5 | `LAIR-SESSION-TCG` |
| Session | RPG Kids Session | $10 | `LAIR-SESSION-RPG-KIDS` |
| Session | RPG Session | $15 | `LAIR-SESSION-RPG` |
| Curse of Strahd - D&D Roleplaying Session | 240 | $15 | `LAIR-SESSION-STRAHD` |

In the 60 days to 28 Oct the Session product was rung up in 516 orders, nearly all of them card sales at the counter.
Most had nobody on the sale (25 to 28 Oct: 3 of 27), so scanning the member's code first (section 5) is what makes
these stamp.

## 4. Stamps staff add

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /members/:customerId/stamps` | staff with Check-in or Members (the main account always) | `{ count: 1–10, note?, key? }` | `{ member, stamp, repeated }` |
| `POST /members/:customerId/stamps/:stampId/undo` | the same | `{}` | `{ member, stamp, already }` |
| `POST /pos/stamp` (internal, the POS tile) | the counter | `{ customerId, key, note? }`: one stamp | `{ stamp, repeated, loyalty }` |
| `POST /pos/stamp-undo` (internal) | the counter | `{ customerId, id }` | `{ stamp, already, loyalty }` |

- `key`: 8 to 64 letters, numbers, dashes or underscores. The same key again (a double tap, a retry after a lost
  answer) gives back the first row with `repeated: true`. The same key on someone else's card is refused.
- **Limits (after the review)**, so nobody can fill a card (a d20 roll for store credit) by tapping: a helper can't add
  stamps to their own card (403 `ownCard`; the main account can); a helper without Members adds one at a time (403
  `oneAtATime`); and the counter and helpers without Members add at most **2 a member a Lair day** between them (409
  `daily`; a stamp taken back doesn't count). The main account and helpers with Members aren't limited on the member's
  page. `created_by` says where it came from: `pos:…`, `checkin:<id>` (a helper without Members) or `staff:<id>`.
- `member` is as `GET /members` lists them, plus `stamps`: their ledger, the last 20 rows newest first, undone ones too.
  `GET /members/:id` (the member's page) has `stamps` too.
- `stamp`: `{ id, kind, count, at, title, note, addedBy, orderName, undoneAt, undoneBy }`. `addedBy` and `undoneBy` are a
  team member's first name, `'the counter'` or null (a sale's `addedBy` is null: `orderName` says which order).
- The counter can only take back stamps it added itself (`notHere` for a sale's, or one added on the staff page); the
  staff page takes back any.
- Undo twice: `already: true`, nothing more.
- `loyalty` (the counter's): `{ stamps, cardSize, rollsAvailable, card }`.

**The staff page's check-in card.** A member code at check-in (`POST /checkin { code }`) now answers with their card,
`loyalty: { stamps, cardSize, cards, rollsAvailable, card }`, so the member card at check-in shows it with **Add a
stamp** (one a tap, its own key until it goes on) and **Undo that stamp** for the ones added there. A helper with only
Check-in can give a stamp there without opening the member's page (which needs Members).

### Words

Every message, word for word (`STAMP_WORDS`):

| Key | Words |
|---|---|
| `count` | Add between 1 and 10 stamps. |
| `noMember` | There's no loyalty card for them yet: they need a Dice Goblin account. Scan the member code in their My Lair. |
| `badKey` | That tap didn't come through properly. Try again. |
| `notFound` | That stamp isn't on their card any more. Scan their code again. |
| `notTheirs` | That stamp is on someone else's card. Scan their code again. |
| `notHere` | That stamp didn't come from the counter, so take it back on the staff page, under Members. |
| `ownCard` | You can't add stamps to your own card. Ask the main account. |
| `oneAtATime` | More than one stamp at a time needs the Members permission. Ask the main account to tick it on the Team tab. |
| `daily` | That's 2 stamps added at the counter or check-in for them today. Any more go on the staff page, under Members. |
| `staffTitle` | A stamp from Gobgob |
| `saleTitle` | A session at the counter |

## 5. The counter tile

- **Scanning a code puts the person on the sale.** A member code, or a ticket on someone's account, sets the cart's
  customer straight away when nobody's on it (`scanCustomer`), things in the cart or not: a sale rung up first and
  their code scanned at the till is theirs. It never swaps out someone already on the sale (they may be paying for this
  person: **Put … on this sale** does that), and leaves a cart with a share of a bill alone (the friend paying is the
  one on it). A toast says "Sam is on this sale".
- **The card is drawn like a punch card**: two rows of five, stamps filled, "7 of 10 stamps" big, then what's left in
  words ("3 more fill the card: a d20 roll for store credit."), rolls waiting, and a "New stamp" badge on stamps that
  landed while the screen was open. On a ticket it says whether this session's stamps are on yet.
- **Add a stamp** on a member's screen (one a tap, with **Undo that stamp**), for a session the Lair app doesn't know
  about: check-ins and payments stamp by themselves.
- A ticket's scan and check-in answer bring its account's card (`loyalty`), as a member code's does (none for a guest's
  ticket).

## 6. Card payments at the counter (Pay on Verifone)

`ordersPaid` now treats an order as a **counter sale** (`counterSale` in `src/counter.js`) when its `source_name` is
`pos` or OrderMate's app ID, or it's from an app (a numeric source) and tagged `OrderMate`. Customers can't make one: the
online store's orders are `web`, our checkouts `shopify_draft_order`.

On a counter sale, a line that lost its properties still counts:

- **Bookings and sign-ups by the code in the title.** Every line the tile puts in the cart has its code in its title,
  in its first 120 characters (a long name is cut short instead): "Table fee: SJ-OWLBEAR-17 (T4, 3 people)", "GM seat:
  Barons (MA-HARP-10)", "Event entry: Trivia night (KT-KRAKEN-7)", "Game spot share: Warhammer night (SJ-OWLBEAR-17,
  Sam)", "Table fee share: JA-KEY-1 ($10 of $60 left)" and, new in this round, **"Owed: Barons (Sun 18 Oct,
  MA-HARP-10)"**. A custom sale (no product) without `_booking` pays the booking or sign-up its title names, when
  exactly one does. It counts what the line paid (price × quantity, less its discounts), once per order line, like a
  `_booking` line. Lines from before this round (an "Owed:" title without its code) pay nothing.
- **A monthly account's tab from an earlier day** by its ref in the title: "Tab: Tue 15 Sep (2 things, TAB-1A2B3C)".
- **Today's tab**: its items go in the cart as the shop's own products, so on a Pay on Verifone sale, a tab the tile
  put in the cart in the 3 hours before the sale (`TAB_CART_WINDOW`, from the order's processed time; putting it in a
  cart again starts the time again) for the sale's customer is paid when the sale has every one of its items (the same
  variant, at least as many), newest tab first, each line used once. Never on Shopify POS's own sales (they keep
  `_tab`), so a tab left at the counter from a cleared sale isn't paid by a later purchase of the same snacks.
- A counter payment sends no booking confirmation, and a pass sold this way says "Bought at the counter".

Shopify POS's own orders work as before (`_booking`, `_tab`). What the tile shows staff is unchanged.

**Not done in this round: the sales before it.** Card payments since the tile went live (early October) are still
unpaid in the Lair. A catch-up (a report first of which counter sales paid which sessions, and which were paid twice,
then applying it with Mo's yes) is the next step.

## 7. What changes for clients

- `GET /me` `loyalty` and every staff view of a card count paid sessions and ledger rows.
- `GET /members/:id`: `stamps` (the ledger).
- `POST /checkin` with a member code: `loyalty`.
- `POST /pos/scan` and `POST /pos/checkin` for a ticket on an account: `loyalty`.
- `orders/paid`'s answer (internal): `stamps` (how many a sale's session products made) when there were any; `tabs`
  includes tabs paid by their items.
- The counter's cart lines: "Owed:" titles end with the code; an account tab's line ends with its TAB ref.

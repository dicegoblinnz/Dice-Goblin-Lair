# Lair API contract v34: the Tavern (drinks ordered from the table, made from staff phones)

Round 34, from 8 November 2026. Mo (8 Nov 2026): "I wanna add hot chocolate to the mix and start on working the menu
into the website for people to scan the QR code and make an order online. And it gets added to their account and they
pay for it when they are ready to pay. When an order is made a notification will be sent to the staff on call, Caleb
Friday, Saturday, Sunday, and Felix is Monday, Tuesday, Wednesday and Thursday ... with a ring ... With a list of drinks
for them to do ... click on the drink and see what quantities of ingredients is needed and what steps ... an order pad of
sorts to walk around and take orders using their phones ... a proper display on the phone to show customers ... add a
member to a drink order by scanning their QR code using the phone's camera." And: "Make sure the bubble teas are not
live on online orders, only in-store works."

His answers (8 Nov 2026): hot chocolate is a **sachet, $3**; when the person on call hasn't tapped On it within
**2 minutes**, **every staff phone and Mo** are rung; nobody knows yet what phones Caleb and Felix carry (so both
Android and iPhone are supported); recipe amounts are **drafted by Claude and checked by Mo**.

**Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days and weekdays in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

The printed menu this follows is the canvas "Tavern drinks menu" (poster, table card, barkeep's guide).

## 1. The menu (round 34a, `src/tavern-menu.js`)

One list the order page, the staff phones, the till and the recipe cards all read, so a price or recipe is changed in
one place. Prices are the Lair's: a page never sends a price the Lair believes.

- Twelve numbered drinks in three tiers: Common $8 (1–4, sparkling), Rare $9 (5–10, creamy), Legendary $10 (11 the
  cookies and cream shake, 12 the mango slushy). Each has its plain name, its fantasy name, what's in it, its usual
  topping and whether it has caffeine.
- Brew Your Own, $10: a base (sparkling or creamer), one or two flavours (fruit syrups, creamy powders), a topping.
- Hot drinks: coffee $3 (latte, caramel latte, cappuccino, strong cappuccino, double shot latte; cappuccino and caramel
  latte also 99% sugar free), hot chocolate $3 (sachet), tea $2 (English breakfast, decaf black tea, peppermint,
  camomile, lemon and ginger), Pukka tea $3 (three mint, three ginger, vanilla chai, lemon, ginger and manuka honey).
  No green tea anywhere (Mo, 8 Nov 2026).
- Toppings (one with every cold drink): popping pearls (strawberry, mango, blueberry, peach, pineapple, passionfruit) or
  jelly (brown sugar, coffee). No mini marshmallows (Mo, 8 Nov 2026).
- Your way, on any cold drink: add sweetness (free; with or without, no levels: Mo, 8 Nov 2026), less ice or no ice
  (free), takeaway cup (free), extra topping +$1, oat milk +$1 (creamy drinks: it replaces the creamer), make it frozen
  +$2 (not the shake or the slushy, which are blended already; Brew Your Own too, so a frozen one costs $12).
- Creamer, never fresh milk (Mo, 8 Nov 2026). The shake is our own ice cream and milk.
- Every drink's recipe card: the amounts and the steps, worked out for the drink as ordered (frozen, oat milk, extra
  topping, sweetness, ice). The amounts are **drafts** from standard bubble tea doses for a 700 ml cup (the dose Mo uses
  in his 600 ml mugs, with less ice) until Mo checks them; every card says so while `draft` is true.

## 2. In the Lair only

- Drinks are **never sold through the website's checkout**. Each drink is a Shopify product on the **Point of Sale
  channel only** (SKUs `TAVERN-…`), so there's no product page or cart for it online. The Lair finds them with the Admin
  API, which sees counter-only products (as the till already does). The old "Drinks" product ($2–$6, unlisted but
  published to the Online Store because the till's quick keys and My Lair's tab menu read it through the theme) comes
  off the Online Store when the till switches to the Tavern menu.
- Ordering from a phone works only **at a table in the Lair, while it's open**: each table's QR code carries the table
  and a code the Lair checks; outside opening hours, or without a table's code, the page shows the menu but no Order
  button. A photo of a table's QR taken home orders nothing useful (it goes on the member's own tab, paid at the
  counter), and staff see every order and can cancel one before it's made.
- Ordering needs a logged-in member (Mo: "it gets added to their account"). Walk-ins order through staff (the order
  pad, section 5).

## 3. Orders onto the tab (round 34a, `src/tavern.js`, built 19 Nov 2026 on branch `r34-tavern`, not live)

Mo (19 Nov 2026): "start building the drink online menu for people to order from ... make it staff facing too so that
when an order is made the staff will get a notification and that notification will tell them what the drink is and when
they are on the staff side of the drink making they see what's on order and we will have instructions on how to make
it ... the creamy ranges is 3 scoops of creamer and 2 scoops of the flavour with a full list of instructions I will send
it tomorrow."

- `GET /tavern/menu[?t=code]` (anyone): the menu as section 1 (no recipes), `open` (inside today's opening hours),
  `rush` (the Rush sign is out: only the quick drinks, 1–7 and 9, and hot drinks) and `table` (`{ id, room }` when `t`
  is a table's code, else null).
- `POST /tavern/orders { table, lines }` (a logged-in member; 401 otherwise): `table` is the code from the table's QR
  card (422 when it matches none), each line `{ item, options }`. The Lair checks opening hours (409), the Rush sign
  and every option, prices it from its own menu, and puts it on **today's tab** as locked lines. Answers `{ order }`:
  `{ id, table, at, total, drinks: [{ id, item, no, name, fantasy, words, price, status, caffeine }] }`.
- **Shopify's price must be the menu's.** Each part of a drink (the drink, extra topping, oat milk, frozen) is a
  counter-only variant found by its SKU (`TAVERN-…`, kept 5 minutes). If one is missing, not on sale, or priced
  differently from the menu, the order is refused (503, "order at the counter") and nothing goes on the tab: the till
  charges Shopify's price, so nobody is charged a price the menu didn't show. A price is changed in the menu file and
  in Shopify together.
- **The tab's locked lines**: `{ variantId, title, variantTitle, price, qty, locked: true }`, one line a variant (the
  same drink again counts it up). `POST /tab` keeps them as they are whatever the page sends (a locked line sent back
  isn't counted twice), and `POST /tab/clear` clears everything else. A tab at the counter (`in-cart`) takes no more
  drinks until it's paid (409); after it's paid the next order starts a fresh tab. A monthly account's credit limit
  holds for drinks too. Paying is as for any tab.
- `GET /tavern/mine` (a logged-in member): today's orders, newest first, each drink `waiting`, `making`, `done` or
  `cancelled`.
- **Table codes**: `GET /tavern/tables` (staff) lists every table on the floor with its code (8 letters and numbers,
  made once and kept), for the QR cards: a card opens the order page with `?t=<code>`.

## 4. The staff's side (round 34b)

**Built (19 Nov 2026, same branch):** the list, for anyone the staff page lets in (the owner or a helper, with their own
login, as Stock off).

- `GET /tavern/queue`: `{ now, rush, ringing, orders }`: the orders with a drink still to make, oldest first, each
  `{ id, table, name, at, waited, onIt, ringing, total, drinks }`, and each drink with its **recipe card** (`recipe`:
  the cup, the amounts and the steps for the drink as ordered, and the member's note). `ringing` counts the orders
  nobody has tapped On it for: the page rings while it's above 0. An order older than 12 hours is off the
  list (review, 20 Nov 2026: one nobody made must not ring the next morning); it stays on the member's tab for the till.
- `POST /tavern/orders/:id/on-it`: someone's making it. The ring stops and its drinks show `making` to the member.
- `POST /tavern/drinks/:id/done`: made. It leaves the list (the order leaves with its last drink).
- `POST /tavern/drinks/:id/cancel`: a drink not made yet comes off the list and off the member's tab. A made drink
  stays on the tab (409); so does one on a tab that's at the counter or paid (409: the till takes it off or refunds).
- `POST /tavern/rush { on }`: the Rush sign out or in. It comes in by itself when the day changes.
- **Recipes**: Mo's first rule is in (the creamy range: 3 scoops of creamer, 2 scoops of the flavour). The rest are
  still drafts (`draft: true` on every card) until his full list arrives; the amounts live in `src/tavern-menu.js`.

## 4a. The two screens (round 34b, `src/tavern-pages.js`, built 19 Nov 2026 on branch `r34-tavern-orders`, not live)

Mo (19 Nov 2026): "build the order page at the table and the staff drinks screen with the ring, matching the canvas
'Tavern ordering: phone screens'." And of the mockups: colour, each drink as an icon or drawing, the fancy name on top
with the actual name under it, kept apart from the other descriptors, animated if possible.

- **Served by the Lair, through the store** (a change from "the order page (theme)"): `GET /tavern` is the order page
  and `GET /tavern/drinks` the staff's list, so they open at `www.dicegoblin.nz/apps/liar/tavern?t=<code>` and
  `.../apps/liar/tavern/drinks`. Shopify still says who's logged in, the theme needs only a link, and a table's QR card
  points at the first address. Each page is the same for everyone and holds nothing about anyone: it asks the routes
  in sections 3 and 4. Only its own script and styles run (a fresh nonce each time), it's never kept or framed, and it
  only ever shows what the Lair sends as text.
- **The order page**: every drink as a card (its drawing in its own colour, the fantasy name, then "No. 5 · Taro Milk",
  then what's in it), in Common, Rare, Legendary, Brew Your Own and Hot drinks. The green plus opens **make it your
  way** (topping, ice, add sweetness, takeaway cup, oat milk, extra topping, make it frozen, a note; Brew Your Own's
  base and flavours; which coffee or tea), with the price on its button. The bar along the bottom adds the order up
  and opens it to take a drink off; **Order** sends it. Nobody logged in: the bar says Log in to order, and the drinks
  picked are still there after logging in. No table code, or closed: the menu, and no Order button. The Rush sign out:
  the slow drinks show as Resting. After ordering: "Your drinks today", each In the queue, Being made, On its way or
  Cancelled, asked for again every 20 seconds while one is still to come.
- **The staff's list**: orders oldest first. A new one is a light card with **On it**; once someone's on it, each drink
  has **Recipe** and **Done**. The recipe card: the plain name, the cup, how it was ordered, the member's note, what
  goes in, the steps, **Done**, and "Can't make it: cancel this drink" (two taps). The Rush sign is a button at the top.
- **The ring**: the page asks for the list every 5 seconds. With the ring turned on (one tap, which a phone needs
  before a page may make a sound), it rings and buzzes (every 3.2 seconds since 4b) while any order has nobody on it, on every phone
  with the page open, and keeps the screen awake. It can't ring a locked phone or a closed page: that's the Drinks app
  below.
- Checked in a real browser by `tools/qa/round34-tavern/screens.mjs` (orders as a member, makes them as staff).

## 4b. Goblin's Apothecary (20 Nov 2026, live)

Mo (20 Nov 2026): "change the name from tavern to the apothecary or goblin's apothecary or something like that since the
naming fits that now"; "make the bell ring something less high pitch and annoying ... fitting to the theme"; "make the
straw do a little swirl after the bubbles are floating for a second or two and when the swirl is happening a reaction
happens and a magical explosion with the colour and sign of the name appears ... make the other drinks staggered ...
give special names for the coffee and chocolate hot drinks and teas too"; "make the drink land on their tab".

- **The name** people read is **Goblin's Apothecary** (the pages, their titles and the Lair's messages). The pages also
  open at `/apothecary` and `/apothecary/drinks`; `/tavern` and `/tavern/drinks` still work. The code, the routes
  (`/tavern/...`), the SKUs (`TAVERN-…`) and this contract keep the old name.
- **Hot drinks have potion names**: Coffee is Second Wind, Hot Chocolate is Warmth Potion, Tea is Clarity, Pukka Tea is
  Calm (Claude's picks, for Mo to change).
- **Each drink's reaction** on the order page, an 8-second round: the bubbles rise, at about 1.5 seconds the straw
  stirs, and at about 2.5 seconds the sign of its name bursts out in its colour for about 2 seconds (a heart with a
  plus, a blue star, a lightning bolt, a clover, a moon, a heart with a spark, a drop with a tick, a dumbbell, a flame,
  a spiral, a shield, a snowflake, a flask; wind, a sun, an eye and a leaf for the hot drinks). Each card starts 3.1
  seconds on from the one before, so no two go off together. The staff's list keeps the quiet drawings. Nothing moves
  for someone who has asked their phone for less motion.
- **The ring** is two potion bubbles and then a brass shop bell, two low notes falling, every 3.2 seconds (it was a
  high two-tone beep every 2).
- **Shopify's products exist** (20 Nov 2026): 17 drinks and the 3 extras, each on the Point of Sale channel only, at
  the menu's prices, stock not counted. So an order now goes on the member's tab; a made drink stays on it until it's
  paid at the counter. After ordering, the page links to the tab in My Lair.
- **Table links**: the staff's list has a button that shows each table's own order link, to try an order or to make
  the QR cards.

**Still to build:**

- **The Drinks app**: the staff's list added to a phone's home screen, so it rings when the phone is locked. A phone
  is linked once from the till (Link a phone: a code that lasts 10 minutes), then the person's till PIN; it stays
  linked until the owner unlinks it on the till.
- **Who's rung**: the person on call (Caleb Friday to Sunday, Felix Monday to Thursday; the owner changes this on the
  till), every 30 seconds until someone taps **On it**; after **2 minutes**, every linked staff phone and Mo's too.
- **Android**: a notification that rings and vibrates and stays until it's tapped. **iPhone**: the app must be added to
  the home screen (iOS 16.4 or later) for notifications; the phone's own notification sound plays.
- The list and its recipe cards on the till.
- **Mo's full recipe list**: not in yet (19 Nov 2026). Every card still says "Draft amounts until Mo's list is in."

## 5. The order pad (round 34c)

- On the Drinks app: the menu as big buttons, a **Show the customer** view (pictures, names and prices, large, for
  turning the phone round), and **Scan their code** with the phone's camera to put the order on that member's tab.
- A walk-in without an account: a first name and table; it shows at the till under tonight's list to pay.

## 6. Going live (round 34d)

Shopify products made by the Lair (owner, on the till: Set up the Tavern), the till's drink keys and My Lair's Tab
menu switched to the Tavern, a QR card for each table, then one test night with Mo before it's switched on.

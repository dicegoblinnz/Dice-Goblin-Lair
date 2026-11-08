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

## 3. Orders onto the tab (round 34a)

- `GET /tavern/menu` (anyone): the menu as section 1 (no recipes), `open` (ordering open now), `rush` (only the quick
  drinks while the Rush sign is out: 1–7 and 9), and the table when `?t=` is a table's code.
- `POST /tavern/orders { table, lines }` (a logged-in member): each line `{ item, options }`. The Lair checks the table
  code, opening hours and every option, prices it, and puts it on **today's tab** as lines that are locked (the member
  can't take them off; staff can, before the drink is made). Answers `{ order }`.
- `GET /tavern/mine` (a logged-in member): today's drinks and where each one is (waiting, being made, done).
- The tab: Tavern lines carry `locked: true` and the order's id. Saving the tab from My Lair keeps them. Paying is as
  for any tab: at the counter (till or POS), with cash or store credit in My Lair.

## 4. Staff phones (rounds 34b and 34c)

- **The Drinks app**: a page staff add to their phone's home screen (served by the Lair, not the theme, so it can ring
  and keep working as an app). A phone is linked once from the till (Link a phone: a code that lasts 10 minutes), then
  the person's till PIN; it stays linked until the owner unlinks it on the till.
- **Who's rung**: the person on call (Caleb Friday to Sunday, Felix Monday to Thursday; the owner changes this on the
  till), every 30 seconds until someone taps **On it**; after **2 minutes**, every linked staff phone and Mo's too.
- **Android**: a notification that rings and vibrates and stays until it's tapped. **iPhone**: the app must be added to
  the home screen (iOS 16.4 or later) for notifications; the phone's own notification sound plays. With the app open
  on either, it rings loudly until On it is tapped.
- **The list**: drinks to make, oldest first, with the table, the member's first name and how long they've waited. Tap
  a drink for its recipe card; **On it**, then **Done** (the member's My Lair shows it's on its way).

## 5. The order pad (round 34c)

- On the Drinks app: the menu as big buttons, a **Show the customer** view (pictures, names and prices, large, for
  turning the phone round), and **Scan their code** with the phone's camera to put the order on that member's tab.
- A walk-in without an account: a first name and table; it shows at the till under tonight's list to pay.

## 6. Going live (round 34d)

Shopify products made by the Lair (owner, on the till: Set up the Tavern), the till's drink keys and My Lair's Tab
menu switched to the Tavern, a QR card for each table, then one test night with Mo before it's switched on.

# Lair app API: round 9, team (9 Oct 2026)

**Changes only.** On top of `lair-api-contract-v8.md` and everything before it; where they disagree, this file wins.
Money in cents, times in ms (UTC), days in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }`
with a 4xx or 5xx. Branches: backend `r9-team-api`, theme `r9-team`.

Mo (9 Oct): "since adding staff requires me to pay more which I don't want to, can we have a special option inside the
main account … to give a member the staff option and they will gain access to what ever I allow but mainly about
checking people in and booking tables out. … With all the other bells and whistles left to me." And: "the member view
for staff … add or remove credit … see library choices and finally the option to email them directly". And: "when a
customer is added all we need is their client id code to add them to games etc. or their email … if I added a customer
3 times and they sign up once they automatically add the other two."

---

## 1. Owner, helpers and permissions

- **Owner:** any customer tagged `staff` in Shopify (today only the main account). Every permission, including `team`.
  Nothing changed for the owner.
- **Helper:** a member the owner made a helper on the Team tab. Kept in the Lair (`staff_helpers`), never as a Shopify
  tag. `who.staff` is true for helpers too, with `role: 'helper'` and the `perms` ticked. **A new helper starts with
  `checkin` and `tables`.**
- `person(customerId)` → `{ customerId, staff, gm, tags, role: 'owner' | 'helper' | null, perms: [...] }`. Tags are kept 5
  minutes as before; helper rows are read on every request, so a change on the Team tab counts straight away. A helper
  keeps working when Shopify can't be asked for tags.
- **The gate:** `requireStaff(who, perm)`. `perm` is a key, or a list where any one will do. The owner passes every gate;
  a helper passes when they have the key; **a missing or unknown `perm` is the owner's alone**, and `team` is never a
  helper's. Not staff: 403 "Staff only. Log in with your staff account." Staff without the permission: 403 "That's not one
  of your staff permissions. Ask the main account to tick it on the Team tab."
- A `who` made in code with `staff: true` and no `role` (the POS's pass undo, and older tests' stand-in `person`) is the
  owner, exactly as before round 9. `person()` always gives a role, so no request can reach that.
- **Other builders' new staff routes** keep calling `this.requireStaff(who); // perm: <key>`: without a key they're owner
  only until the coordinator fills the key in at merge (the safe default).

### Permission keys
| Key | Covers |
|---|---|
| `checkin` | The check-in desk: scanning and looking up codes, checking in, Today's bookings, paid and no-shows at the desk, passes at check-in |
| `tables` | The floor, walk-ins, staff table bookings and moves, holds and openings |
| `sessions` | GM games: making and editing sessions, players, regulars, invites, approving, cancelling, pictures, messages |
| `events` | The events editor, and adding people to event sign-ups |
| `members` | The members list and a member's page, birthdays, gifts and rolls, member codes, emailing a member |
| `money` | Store credit, passes and groups, loot codes, refunds, waiving owed seats, a GM's store credit (tab: tabs and monthly accounts) |
| `library` | Library holds, check out and in, back on the shelf, reserving for someone |
| `community` | Turnouts, lists and early access (community's routes) |
| `team` | Managing helpers. Owner only, never given |

### Staff routes table (every staff route and staff-only read, and what it needs)
"A or B" means either will do. Routes not in this table are customers' or the POS's (the POS keeps its own auth).

| Route | Needs |
|---|---|
| `GET /floor` staff view (names, emails, payments, every sign-up, staff holds) | `checkin` or `tables` or `sessions` or `events` (anyone else sees the public floor; `staff` in the answer says which) |
| `POST /checkin` | `checkin` |
| `POST /bookings` `kind: 'walkin'`, or `staffOverride: true` | `tables` |
| `POST /bookings/:id/update` `status`, `paid`, `people` | `checkin` or `tables` |
| `POST /bookings/:id/update` `tables`, `end` (a move) | `tables` |
| `POST /bookings/:id/update` `refunded`, `waived` | `money` |
| `POST /bookings/:id/update` on a sign-up: `status`, `paid` | `checkin` or `events` |
| `POST /bookings/:id/update` on a sign-up: `refunded` | `money` |
| `POST /blocks`, `POST /blocks/:id/delete`, `POST /openings`, `POST /openings/:id/delete` | `tables` |
| `POST /games` for a GM (`gmCustomerId`/`gmEmail`); staff games' shop tables and straight-on-the-board | `sessions` |
| `POST /games/:id/edit`, `/players`, `/update` (staff), `/sessions` (staff), `/message` (staff, no daily limit), `/image` (staff) | `sessions` |
| `POST /series/:id/leave` with `customerId` or `inviteId` | `sessions` |
| `POST /games/:id/credit` (the GM's store credit) | `money` |
| `GET /events`, `POST /events`, `/events/:handle/update`, `/events/:handle/delete`, `POST /events/pictures` | `events` |
| `POST /events/:occurrenceId/joins` (new, section 3) | `events` |
| `POST /events/joins/:id/cancel` as staff (anyone else's, refund due) | `checkin` or `events` |
| `GET /members`, `GET /members/:id`, `GET /members/:id/spend`, `GET /members/birthdays` | `members` |
| `POST /members/:id/gift`, `/rolls`, `/since`, `/new-code` | `members` |
| `GET /members/:id/emails`, `POST /members/:id/email` (new) | `members` |
| `GET /members/:id/credit`, `POST /members/:id/credit` (new) | `money` |
| `POST /prizes/:id/done` | `checkin` or `members` |
| `GET /passes` | `money` or `checkin` or `members` |
| `POST /passes`, `/passes/:id/update` | `money` |
| `POST /passes/:id/apply`, `/passes/uses/:id/undo` | `checkin` or `money` |
| `usePass` on a booking for any pass (staff) | `checkin` or `tables` or `money` |
| `GET /groups`, `POST /groups`, `/groups/:id/update`, `/groups/:id/members` | `money` |
| `GET /roll-codes`, `POST /roll-codes`, `/roll-codes/:id/update` | `money` |
| `GET /customers` (the picker) | any of `members`, `money`, `sessions`, `events`, `library`, `checkin`, `tables`, `community` |
| `GET /library/holds`, `POST /library/holds/:id/update`, `GET /library/loans`, `POST /library/loans`, `POST /library/return` | `library` |
| `POST /library/holds` with `customerId`; `/library/holds/:id/cancel` and `/library/loans/:id/return` as staff | `library` |
| `GET /team`, `POST /team`, `POST /team/:id`, `POST /team/:id/remove` (new) | `team` (owner only) |

Abuse limits that skip staff (per client, per email, the contact form, booking emails) skip helpers too: they aren't
permissions. A helper without a permission is a member everywhere else: they can still cancel their own booking or
sign-up, and run their own GM games.

### Routes
- **`GET /staff/me`** (logged in) → `{ staff: false }`, or `{ staff: true, role: 'owner' | 'helper', perms, name }`
  (`perms`: the keys; the owner's are every key and `team`; `name`: their first name). 401 "Log in to use the staff page."
- **`GET /team`** (owner) → `{ owners, helpers, perms, defaults, log }`:
  - `owners`: `[{ customerId, name, email, code }]`, whoever's asking first, then others Shopify finds tagged staff;
  - `helpers`: `[{ customerId, name, firstName, email, code, perms, since, updatedAt, madeBy: { customerId, name } | null }]`, newest first;
  - `perms`: `[{ key, words }]` in order (what can be ticked; never `team`); `defaults`: `['checkin', 'tables']`;
  - `log`: the last 30 `{ at, action: 'added' | 'changed' | 'removed', customerId, name, perms, by: { customerId, name } | null }`.
- **`POST /team`** (owner) `{ code }` (a member code, any case, dashes optional) or `{ customerId, name?, email? }` (from the
  customer search: someone the Lair hasn't met becomes a member), and `perms?` (left out: the defaults) → `{ helper }`.
  Already a helper: their permissions change (logged 'changed'). Errors:
  - 404 "No member has that code. Check it, or find them in the search."
  - 404 "That customer could not be found. Pick them from the search again." (round 7's picker words)
  - 422 "Pick a member from the search, or type their member code."
  - 422 "Tick at least one thing they can do."
  - 409 "That's the main account. It can do everything already." (the asker, or anyone tagged staff)
- **`POST /team/:customerId`** (owner) `{ perms }` → `{ helper }`. 403 "You can't change your own permissions. Ask the main
  account." 404 "They're not a helper." 422 "Tick at least one thing they can do."
- **`POST /team/:customerId/remove`** (owner) → `{ ok: true, customerId }`; they're a customer again at once (their row is
  kept, 'removed'). 409 "That's you, the main account. It can't be removed here." 409 "That's the main account. It can't
  be removed here." 404 "They're not a helper."

## 2. Member tools on the staff member page

- **`GET /members/:customerId/credit`** (`money`) → `{ balance, currency, problem, history }`. `balance`: their Shopify store
  credit in cents (0 with no account in NZD), or null with `problem` saying why:
  - "Shopify hasn't let the Lair read store credit balances yet. Approve the app's new permission in Shopify admin (Apps › Dice Goblin Lair)." (needs `read_store_credit_accounts`, now listed in the health check's optional permissions)
  - "Shopify didn't answer just now, so the balance isn't showing. Try again in a minute."
  - "Shopify isn't connected, so the balance can't show."
  `history`: the last 20 changes made here, newest first: `{ id, amount, note, status: 'pending' | 'done' | 'failed', balanceAfter, message, at, by: { customerId, name } }`.
  404 "No member with that customer ID."
- **`POST /members/:customerId/credit`** (`money`) `{ amount (cents: + adds, − takes off), note, key }` → `{ change, balance }`
  (`balance` after, from Shopify). Shopify `storeCreditAccountCredit` (with `notify: false`) or `storeCreditAccountDebit`.
  Logged first ('pending'), then 'done' with Shopify's transaction and balance, or 'failed' with the words. `key`: the
  page's own key for one change; the same key again answers the first result with `repeated: true` and moves nothing.
  - 422 "Say how much to add or take off." (0, not whole cents)
  - 422 "Store credit changes go up to $1000 at a time. Check the amount."
  - 422 "Add a note to say why the credit is coming off."
  - 409 "Ruby has $25 of store credit, so you can take off $25 at most." / "Ruby has no store credit to take off." (checked
    against Shopify's balance first, when Shopify will say)
  - 409 "Ruby doesn't have that much store credit, so nothing came off. Check their balance and take off less." (Shopify's
    INSUFFICIENT_FUNDS, when the balance couldn't be read first)
  - 502 "Shopify didn't change the store credit (<Shopify's words>). Nothing changed. Try again."
  - 503 "Shopify isn't connected, so store credit can't change right now."
- **`GET /members/:customerId/emails`** (`members`) → `{ to, emails, left, limit }`: `to` their email ('' with none); `emails`
  the last 20 staff sent them, newest first: `{ id, subject, email, status: 'sending' | 'sent' | 'failed', message, at, by }`;
  `left` how many more this staff member can send today; `limit` 30.
- **`POST /members/:customerId/email`** (`members`) `{ subject, message, signedAs? }` → `{ email, left }`. Sent through
  Resend from FROM_EMAIL, reply-to STAFF_EMAIL, in the shop's email look (`renderEmail`): the subject as its title, the
  message as written (a blank line starts a paragraph, line breaks kept, any HTML shown as text), signed
  "<signedAs or the sender's first name>, Dice Goblin". 30 a day per staff member (failed ones don't count).
  - 422 "Ruby has no email on file, so there's nothing to send to."
  - 422 "Add a subject, up to 120 characters." / "Write the message, up to 4,000 characters."
  - 429 "That's 30 emails from you today. Try again tomorrow."
  - 503 "Emails aren't set up, so nothing can be sent from here yet."
  - 502 "It didn't send (<Resend's words>). Try again in a minute." (logged 'failed')
- **`GET /members/:customerId`** adds `library.returns`: the last 5 games they brought back, newest first (as staff see
  loans). `plan`, `holds` (with `until`) and `atHome` (with `outAt`) are round 7's.
- Credit limit and the monthly account are the tab builder's (`renderMemberAccount()`).

## 3. Adding people to games and events by member code or email

- **`POST /events/:occurrenceId/joins`** (`events`): add someone to an event date's sign-ups. Who:
  - `{ code }`: their member code, found at once (any case, dashes optional);
  - `{ customerId, name?, email? }`: picked from the customer search (someone the Lair hasn't met becomes a member);
  - `{ name, email }`: someone without an account. An email a member has links them; otherwise they're invited, and the
    sign-up joins their account when they log in with that email (round 6's `adoptGuestBookings`, unchanged).
  Also `people` (1 to 6, 1 when left out), `phone?`, `note?`. The same places and rules as a customer's sign-up, paid at
  the counter (`pay: 'day'`, no checkout, no mobile needed), `added_by` kept. → `{ join (staffJoinView), spacesLeft,
  emailed, invited }`. They get the usual "You're on the list" email; an invitee's also says "Make your Dice Goblin
  account with this email (…), or log in with it if you have one: this sign-up shows up in My Lair, and so does anything
  else the team adds for you." It shows on Today's list and the floor's `joins` like any sign-up. Errors:
  - 404 "That event date could not be found." / 404 "No member has that code. Check it, or find them in the search."
  - 422 "This one doesn't take sign-ups: people just turn up." / 422 "That one has already finished."
  - 422 "Add between 1 and 6 people." / "Add their name." / "That email address doesn't look right."
  - 422 "Add their email, so they get the confirmation and an invite to make an account."
  - 409 "Sam Jones is already on the list for this one (SJ-OWLBEAR-17)." / "Only 2 spaces left." / "This one is full."
- **`POST /games/:id/players`** (round 7) also takes `{ code }`: the member it belongs to is the player (their name and
  email come from their member record unless sent). 404 "No member has that code. Check it, or find them in the search."
- **Adoption:** every staff-added record under an email (event sign-ups, TTRPG seats, weekly seat invites, GM games) joins
  the account that logs in with that verified email, however many there are (tested: added three times, signs up once,
  all three join).

## Stored (team's ONE migration entry, appended last)
- `staff_helpers (customer_id PK, perms JSON, status 'active'|'removed', made_by, created_at, updated_at)`
- `staff_log (id, customer_id, action, perms, by, at)` + index on `(customer_id, at)`
- `member_credit (id, customer_id, amount, note, status, transaction_id, balance_after, message, key UNIQUE, by, at, updated_at)` + index
- `member_emails (id, customer_id, email, subject, status, message, by, at, updated_at)` + indexes on `(customer_id, at)` and `(by, at)`
- `event_joins.added_by` (staff:<customer id> for a sign-up staff added)

## Theme
- `sections/lair-staff.liquid` renders the shell for any logged-in customer (and anyone in demo mode); `<lair-staff>`
  asks `GET /staff/me` first: staff get their tabs, anyone else the locked message (`lair.staff.not_staff`). The main
  account (tagged staff) still gets everything from a Lair app without the route.
- Tabs by permission, one map (`TAB_PERMS` in lair-staff.js): floor → tables; today → checkin; passes, groups, codes → money;
  members → members; holds → tables; games → sessions; events → events; library → library; team → owner. The coordinator adds
  the tab builder's `accounts` (money) and community's `community` (community). A helper with Check-in lands on Today;
  the check-in box shows with Check-in. Buttons for money a helper wasn't given (refunds, waive, issue a pass, GM credit)
  don't show (`lair-staff[data-perms]` in lair-staff-team.css).
- Team tab (`assets/lair-staff-team.js`, `<staff-team>`), the member page's sections (`memberCreditHtml`,
  `memberEmailHtml`, `memberLibraryHtml`, `memberHelperHtml`), the Events tab's `<staff-event-add>`, and "Scan their card"
  plus member codes found at once in the pickers.
- LiveBackend: `staffMe`, `teamList`, `teamAdd`, `teamUpdate`, `teamRemove`, `memberCredit`, `memberCreditChange`,
  `memberEmails`, `memberEmail`, `eventAddPerson`; the demo has each, plus `teamPreview(customerId | null)` (demo only).

## Contract notes (choices made)
- Refunds and waiving owed seats are `money`, not the desk's: "all the other bells and whistles left to me". A GM's store
  credit (`/games/:id/credit`) is `money` too, since it pays out.
- Using or undoing a member's pass at the desk is `checkin` (check-in already used passes); issuing and editing them is `money`.
- Cancelling someone's event sign-up as staff is `checkin` or `events`; a member's own is unchanged.
- The floor's staff view goes with any of `checkin`, `tables`, `sessions`, `events` (every one of those tabs works from it).
- Store credit changes don't ask Shopify to email the customer (`notify: false`): nothing is emailed by surprise; staff
  can tell them with Email them. The cap is the birthday gift's, $1000 a change.
- Email them takes `signedAs` (prefilled with the sender's first name) so a shared or shop-named account signs as a person.
- `POST /team` with someone already a helper changes their permissions rather than refusing.

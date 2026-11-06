# Lair API contract v32: the till, part 1 (who's on the till)

Round 32, 6 November 2026 (the library filters and open games are round 31s of their own). Mo is replacing Shopify POS with the shop's own till (the website's staff page with
`?view=till` on the end, on the counter tablet; plan: the doc "Dice Goblin till: plan"). He asked for his own passcode,
Caleb on 1234, and everyone changing theirs to what they like the first time they log in, Felix too.

**Changes only**, on top of every contract before it. Times in ms (UTC). Errors stay `{ error: "A plain sentence." }`
with a 4xx or 5xx.

PINs never go in the website's code (anyone can read it), so the till's people and their PINs live here. Everyone starts
on **1234** and the till asks them to choose their own PIN the first time they unlock: Mo chooses his then, and Caleb
and Felix choose theirs. Nobody's own PIN is in any code, test or document.

`src/till.js`; tests `test/round32-till.test.js`.

## 1. Who's on the till

The till's people, in this order:

1. The owner: whoever's logged in when they're tagged `staff` in Shopify, then anyone else tagged `staff` (Shopify is
   asked at most every 10 minutes; when it can't be asked, the last answer, or just whoever's logged in).
2. The helpers on the staff page's Team tab (oldest first), with the Team tab's permissions.
3. People the owner adds on the till itself (oldest first). They need no account: a name, and what they can do on the
   till: `checkin` (take payment at the counter and approve cash, as Check-in does on the staff page) and `money`
   (refunds, store credit and tabs, as Money does). Someone new gets `checkin`.

Caleb and Felix are added on the till on its first start (with `checkin`), unless a helper by that first name is on the
Team tab already. Mo ticks Money for them on the till's Team screen if he wants them doing refunds and store credit.

A person, as every till route gives them (`tillPersonView`):

```
{ id, name, fullName, role: 'owner' | 'helper', kind: 'team' | 'till', roleWords, perms, pin: 'start' | 'own',
  off, locked, lockedMinutes? }
```

- `id`: a Shopify customer ID (`kind: 'team'`), or `tp_` and 16 letters and numbers (`kind: 'till'`, added on the till).
- `name`: a first name for the team (from their member record), the name as typed for the till's own people.
- `roleWords`: `Owner`, `Check-in`, `Money`, `Check-in and money` or `Sales only` (what the lock screen says under
  their name).
- `pin`: `start` while they're on 1234 (never chosen, or reset), `own` once they chose theirs.
- `off`: their till access is switched off. `locked`: too many wrong PINs; `lockedMinutes` until they can try again.

## 2. PINs, tokens and lock-outs

- A PIN is 4 numbers. It's kept as HMAC-SHA-256 over `salt:pin`, each with its own random salt, with a key made once at
  random and kept in the Durable Object's key-value storage, not in the Lair's tables. The starting PIN is no row at all.
- Five wrong PINs in a row lock that person out: 5 minutes, then 10, 20, 40, then an hour each time after that, until
  a right PIN (or the owner's reset) starts them at 5 again. Only that person is held up.
- Unlocking gives a token (48 letters and numbers) that says who's on the till for 14 hours. The till keeps it in the
  tablet's memory and sends it in the body (never the address). The Lair keeps only its SHA-256. A token stops working
  when it runs out, when that person's PIN is reset or access switched off, or when they leave the team or the till (a
  helper added back later doesn't get their old tills back).
- Until someone has chosen their own PIN (on 1234 the first time, or after a reset), their token does only one thing:
  choose it. Anything else is a 403 `Choose your own PIN first.` The Lair checks this, not just the till's page.
- **Forgot your PIN (owners):** never a reset on the logged-in account alone, because the counter tablet's account is
  open to anyone at the counter. Instead the owner gets a 6-digit code at their own email (their member record's, else
  Shopify's). The code is kept as an HMAC like a PIN and works once, for 15 minutes; a new one replaces the last, at most
  one a minute and 10 a day. Five wrong codes in a row, across new codes, lock that owner's codes like PINs (5 minutes,
  doubling to an hour). The right code gives a till for 15 minutes that can only choose a new PIN: the old PIN stays until
  the new one is saved, so walking away halfway never leaves them on 1234, and choosing turns it into an ordinary till
  for a shift. Helpers and the till's own people ask the owner to reset theirs.

## 3. Routes

All need a logged-in staff account (the owner or a helper; the till tablet is logged in as one): anyone else gets
403 `The till is for staff. Log in with a staff account.`

| Route | Who | What |
|---|---|---|
| `GET /proxy/till/team` | staff | The lock screen → `{ team: [person], startPin: '1234' }` |
| `POST /proxy/till/unlock` | staff | `{ id, pin }` → `{ token, staff: person, mustChange }`. `mustChange` is true while they're on 1234: the till asks them to choose their own before anything else. Wrong PIN: 401 `That PIN isn't right. Try again.` The fifth in a row, and any try while locked out: 429 `Too many wrong PINs. Try again in 5 minutes, or ask Mo to reset it.` Switched off: 403. Not on the till: 404 |
| `POST /proxy/till/pin` | on the till | `{ token, pin }`: whoever the token is for chooses their own PIN → `{ ok: true, staff: person }`. 4 numbers (400 `A PIN is 4 numbers.`), not 1234 (400 `Choose a PIN that isn't 1234.`). A token that ran out or was stopped: 401 `The till locked itself. Tap your name and your PIN again.` |
| `POST /proxy/till/reset` | the owner on the till | `{ token, id }`: that person goes back on 1234 (they choose their own the next time they unlock), any lock-out is cleared, and their other tills lock → `{ team }`. The owner's own till stays open when they reset their own PIN with it (then it can only choose a new one). No token: 401 |
| `POST /proxy/till/forgot` | staff | `{ id }` of an owner: emails them a 6-digit code → `{ sent: true, to: 'o•••@example.com' }`; asked again within a minute of one going → `{ sent: false, to }` (type that one). Not an owner: 403 `Only an owner's PIN is reset by email. Ask Mo to reset yours on the till.` Locked by wrong codes: 429 `Too many wrong codes. Try again in 5 minutes.` The 11th in a day: 429 `That's 10 codes today. Try again tomorrow.` No email set up or no address: 503. The email didn't go: 502 (ask again straight away; it doesn't count) |
| `POST /proxy/till/forgot/check` | staff | `{ id, code }` (spaces ignored) → `{ token, staff: person, mustChange: true }`: a till for that owner for 15 minutes that can only choose a new PIN (anything else 403 `Choose your own PIN first.`); their other tills lock. Wrong: 401 `That code isn't right. Check the email and try again.`; the fifth wrong in a row, across new codes: 429, the code is gone and codes are locked; ran out: 410; none waiting (used, replaced, never asked): 400 |
| `POST /proxy/till/access` | the owner on the till | `{ token, id, off }`: till access off (their tills lock; unlocking gives 403 `Your till access is switched off. Ask Mo to turn it back on.`) or back on (their own PIN still works) → `{ team }`. Not your own (400) |
| `POST /proxy/till/people` | the owner on the till | `{ token, name, perms? }` adds someone on the till, on 1234; `{ token, id, name?, perms? }` changes someone added on the till → `{ team, person }`. `name`: 1 to 30 characters, spaces tidied, no `<` or `>` (400), not the name or first name of anyone on the till already, any case (409 `There's already a Caleb on the till.`). `perms`: a list, `checkin` and `money` kept, anything else dropped. Helpers are changed on the Team tab (404 here) |
| `POST /proxy/till/people/remove` | the owner on the till | `{ token, id }`: someone added on the till is taken off it; their PIN goes and their tills lock → `{ team }`. Only people added on the till (404 for the team) |

"The owner on the till" is a token from unlocking as an owner who has chosen their own PIN: a helper's token gets 403
`Only the owner can do that.`, an owner still on 1234 gets 403 `Choose your own PIN first.`, no token or a stopped one 401.

## 4. Data

Three tables, made on start when they're missing:

- `till_people (id, name, perms, status, made_by, created_at, updated_at)`: the people added on the till; `status`
  `active` or `removed`; `made_by` `start` (Caleb and Felix) or `till:<owner's ID>`.
- `till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at)`: one row a person,
  once anything about their PIN changed.
- `till_sessions (token_hash, person_id, created_at, expires_at, pin_only)`: the SHA-256 of each token; `pin_only` 1 for a
  till from an emailed code until its PIN is chosen. Ones that ran out are cleared on the next unlock.
- `till_resets (person_id, hash, salt, expires_at, sent_at, failed, lockouts, locked_until, day_start, day_count)`: an
  owner's emailed code (hash null when none is waiting), wrong codes in a row and the lock-outs they caused, and the
  day's codes. Gone after a right code.

The meta row `till-seeded` says Caleb and Felix were added (once).

## 5. Next (not in this round)

Part 2: the till's real members, bookings and tabs. Part 3: real products, prices (the dice deal) and stock, and each
sale saved to Shopify as a paid order with the member, stamps, check-ins and credit. Part 4: cash approvals (a PIN on
the till, or the staff page) and store credit at the till. Every sale will carry who was on the till.

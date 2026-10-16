# Lair app API: round 17, GM credit for staff (16 Oct 2026)

**Changes only**, on top of v16-wishlist and everything before it; where they disagree, this file wins. Money in cents,
times in ms (UTC), days and hours in Lair time (Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a
4xx or 5xx. Backend: `src/staff-gm.js`. Theme: the Team tab (`assets/lair-staff-team.js`), the GM games tab
(`assets/lair-staff.js`), the GM pages' words (`assets/lair-games.js`) and the demo (`assets/lair-demo.js`).

Mo (16 Oct): "I want to make the staff assigned to run roleplaying games for GM games don't get the store credit of $5
per player as I pay them to be there and it needs to not go to them. Please make an option for me to toggle that so
that the players still gets charged $15 and the GMs don't get $5 store credit as they are staff or a toggle so during
staff hours, so if they are on the clock they cannot earn any store credit but outside of their hours they can earn
store credit as anyone else."

## 1. Rules

- **Staff** is the team: the main account (tagged `staff` in Shopify) and the helpers on the Team tab. A helper who's
  removed is like any GM from then on.
- **One setting for the whole team**, the main account's, on the Team tab (`GET /team` `gmCredit`):
  - `never`: staff earn no GM credit for the sessions they run. **This is the setting until the main account picks.**
  - `shifts`: staff earn none for a session that overlaps their hours, even partly (a session that starts as their
    time ends, or ends as it starts, is outside it). Outside their hours they earn it like any GM.
  - `earn`: staff earn GM credit like any GM (as before round 17).
- **Hours** are weekly times for each person on the team, set by the main account: a day (`mon` to `sun`) with a start
  and an end (`HH:MM`, from before to, `24:00` for midnight; an end of `00:00` is read as midnight). At most 3 times a
  day; one day's times can't overlap (one can start when another ends). Someone with no hours is never in them.
- **Players pay exactly what they paid before.** Only the GM's credit changes, and only when staff tap "Session done" on
  the GM games tab (`POST /games/:id/credit`): a staff GM's session the setting keeps the credit from is recorded with no
  credit (`credits.status` `'staff'`, amount 0, a note saying why and what it would have been) and marked done, so it
  can't be credited later. A $0 GM fee, or no paying players, is as before (`'none'`).
- **Marking it** (`shifts` only): the main account can say the GM was working then (`onShift: true`) or wasn't
  (`false`), whatever their hours say, for a swapped shift. Only the main account: a helper with Money is refused, so
  nobody marks their own session. `never` ignores it; so does a GM who isn't staff. The note names who marked it, and
  every credit record keeps who pressed "Session done" (`credits.by`).
- **What the button said** (`expect: 'credit' | 'none'`, from the staff page): if the setting, their hours or the team
  changed since the page loaded and the answer would be different, it's a 409 and nothing is done.
- **Shopify can't be asked** whether a GM who isn't a helper is the main account (their tags): a 503 while the setting
  isn't `earn`, so a staff GM is never paid because Shopify was down.
- The setting is read when the credit is added, with the GM's hours as they are then.
- Loyalty stamps, rolls and prizes aren't touched: staff earn those as customers like anyone.

## 2. Routes

### 2.1 `GET /team` (the main account)

Adds `gmCredit`: `{ mode, choices: [{ key, label, words }], changedBy: { customerId, name } | null, changedAt | null }`,
the choices in this order: `never` ("Never"), `shifts` ("Not in their hours"), `earn` ("Always"), with the words in
section 3. Each of `owners` and `helpers` adds `hours` (`[{ day, from, to }]`, Monday first, then by start) and
`hoursText` (`"Thu 4pm–midnight, Sat 10am–6pm"`, `''` for none). `POST /team` and `POST /team/:customerId` answer
`helper` with them too.

### 2.2 `POST /team/gm-credit { mode }` (the main account)

→ `{ gmCredit }` as above. Errors: 403 for anyone but the main account (helpers too, Money or not); `422 mode`.

### 2.3 `POST /team/:customerId/hours { hours: [{ day, from, to }] }` (the main account)

All their hours at once; `[]` clears them. Days may be sent as `Sat`, `saturday` or `SAT`; times as `9:30` or
`09:30`. → `{ customerId, hours, hoursText }`. Errors, in this order: 403; `422` (`hours`, `day`, `time`, `order`,
`overlap`, `many`); `404 team` for someone who isn't the main account or a helper.

### 2.4 `POST /games/:id/credit { onShift?, expect? }` (Money; `onShift` the main account only)

As before, plus: a staff GM's session that the setting keeps the credit from →
`{ players, amount: 0, status: 'staff', note, withheld }` (`withheld`: what they'd have got, in cents). A staff GM who
earns it (`shifts`, outside their hours or marked not working) → the usual answer with `note` saying so. Errors, in
this order: `422 onShift` (not `true`, `false`, null or left out); `403 markOwner` (`onShift` from anyone but the main
account); `422 expect`; the usual 404s and 409s; `409 changed` (the session's GM changed while the team was checked);
`503 tags`; `409 expectChanged`. A GM listed only by email ('manual') adds to its note, unless the setting is `earn`:
"If they're on the team, check GM credit for staff on the Team tab first."

Notes (`credits.note`, word for word, `<name>` the session's GM name):
- `never`: `No GM credit: <name> is staff, and staff don't earn GM credit (it would have been $10.00 for 2 paying players).`
- in their hours: `No GM credit: it was in <name>'s hours, Sat 10am–7pm (it would have been $10.00 for 2 paying players).`
- marked working: `No GM credit: <name> was working then, as Mo marked on the staff page (it would have been $10.00 for 2 paying players).`
- outside their hours: `It was outside <name>'s hours, so they earn it like any GM.`
- marked not working: `<name> wasn't working then, as Mo marked on the staff page, so they earn it like any GM.`

("Mo" is the main account's first name; "as marked on the staff page" when it has none.)

### 2.5 `GET /floor` (staff view)

Each game adds, for staff with GM games or Money (not a desk-only helper):
- `credit` once it's been credited: `{ status ('credited' | 'manual' | 'none' | 'staff'), amount, players, note, at }`.
- `staffGm` when it's ready for its credit (started, not cancelled, not credited, with a GM account and a GM fee), its GM
  is staff and the setting isn't `earn`: `{ mode, credit (whether "Session done" credits them), onShift (true, false,
  or null for never), shift (the time it overlaps, "Sat 10am–7pm", or null), hours (all their hours, as hoursText) }`.
  The floor never waits on Shopify: helpers are read there, and the main account counts when its tags are known (they're
  kept 5 minutes); otherwise they're asked for after the answer, for the next poll, and "Session done" (which asks
  itself, and refuses with a 409 if the button said otherwise) stays right.

### 2.6 `GET /me`

`customer.staffGmCredit` for someone on the team when the setting isn't `earn`: `{ mode: 'never' | 'shifts', hours,
hoursText }`; otherwise `null`. The GM pages use it to say what a staff GM gets.

### 2.7 GM emails

"Your game is live" and the invite say, for a staff GM: `never` → "None: you're on the Dice Goblin team, and staff
don't earn GM credit for the sessions they run"; `shifts` → "None for this session: it's in your hours (Sat 10am–1pm).
Staff don't earn GM credit in their hours", or the usual line with " (it's outside your hours)". (Staff here is a
helper, or the main account when its tags are already known: the emails don't wait on Shopify.)

## 3. Words (word for word)

| Key | Words |
| --- | --- |
| `never` (choice) | Never: Staff don't earn GM credit for the sessions they run: they're paid to be there. |
| `shifts` (choice) | Not in their hours: No GM credit for a session in their hours, even partly. Outside their hours they earn it like any GM. |
| `earn` (choice) | Always: Staff earn GM credit like any GM. |
| `mode` | Pick one of the three choices for GM credit for staff. |
| `hours` | Send their hours as a list of times, each with a day, a start and an end. |
| `day` | Each time needs a day: Mon, Tue, Wed, Thu, Fri, Sat or Sun. |
| `time` | Each time on Saturday needs a start and an end, like 16:00 and 22:00. |
| `order` | A time on Saturday ends before it starts. Use 24:00 for midnight. |
| `overlap` | Two of the times on Saturday overlap. Make them one. |
| `many` | Saturday has more than 3 times. Join some of them up. |
| `team` | They're not on the team. Make them a helper first. |
| `onShift` | onShift is true (they were working), false (they weren't) or left out (their hours decide). |
| `markOwner` | Only the main account can mark whether a staff GM was working. |
| `expect` | expect is 'credit', 'none' or left out. |
| `expectChanged` | GM credit for staff, their hours or the team changed since this page loaded. Check the session again. |
| `changed` | This session's GM changed. Check the session again. |
| `tags` | Gobgob couldn't check whether the GM is on the team just now. Try again in a moment. |

(`STAFF_GM_CHOICES` and `STAFF_GM_MESSAGES` in `src/staff-gm.js`.)

## 4. Storage

- `meta` `staff-gm-credit`: `{ mode, by, at }` (JSON). No row: `never`.
- `staff_hours` (new, made on start when missing): `customer_id` (primary key), `hours` (JSON list), `by`, `updated_at`.
- `credits.by` (new column): who pressed "Session done" (`staff:<customer id>`). Index `credits_game` (game_id, created_at).

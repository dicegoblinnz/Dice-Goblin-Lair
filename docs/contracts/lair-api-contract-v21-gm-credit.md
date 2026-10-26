# Lair API contract v21-gm-credit: GMs' stamps, and GM credit that adds itself

Round 21 (26 Oct 2026). From Mo, 26 Oct 2026:

- "make sure to make the gm gets entry stamps even if they don't pay for the session. Unless the session got canceled."
  Then: "Staff gms don't get it. But yes since the card began is fine".
- "have each player give the gm credit only when the payment have went through." Then: "Automatic from today."

The code is `src/gm-credit.js` (methods of the Lair Durable Object), with small changes in `src/lair.js` (stamps, the
floor, `POST /games/:id/credit`, the 10-minute run), `src/staff-gm.js` (`readyForCredit`) and `src/shopify.js`
(`creditCustomer`). Tests: `test/round21-gm-credit.test.js`.

A GM paying for one of their players (Mo, same day: "have the option for the gm to pay for someone else if they wish
from one of their players") is the next round, not this one.

## 1. GM stamps

A GM's loyalty card gets **one stamp for each session they ran**, like a player's for a checked-in seat:

- since the card began (the loyalty start, `meta.loyalty-from`), so sessions GMs have already run count;
- once the session has started, unless it's cancelled (status `open` or `full`; never `pending` or `cancelled`);
- only with at least one player booked on it (a `gm-seat` that's confirmed, seated or done and isn't the GM's own):
  a session nobody booked didn't run;
- never for someone on the team: the main account (tagged `staff` in Shopify) or a helper. Whether the GM was on the
  team is looked up once, when the 10-minute run first sees the session under way, and kept in `gm_runs`. So the card
  never waits on Shopify, and a later change on the Team tab doesn't move old stamps. A GM whose tags Shopify couldn't
  read (and who isn't a helper) is looked at again next run; a session given to another GM is looked at again for them.
- A GM checked in on a seat of their own session has that seat's stamp already, so the session gives them no second one.

Like every stamp, it's counted every time, never stored: a session cancelled afterwards takes its stamp back.

**What changes for clients.** Nothing new to call. `GET /me`'s `loyalty` (and every staff view of a member's card)
counts these stamps. `loyalty.recent` lists each one as `{ at, title, people: 1 }`, with the title
`"<session title> (you ran it)"` (`"TTRPG session (you ran it)"` when it has none). The 10-minute run's record shows
`gmRuns: { looked }` when it looked at any sessions.

## 2. GM credit that adds itself

For **sessions starting from midnight on Monday 26 October 2026, Lair time** (`GM_CREDIT.autoFrom`), each player's
seat gives its GM their GM fee in store credit **once the session is over and that seat is paid**:

- paid means `paid` on the seat with an amount over $0: online, at the counter, on a tab or monthly bill, or by a
  session pass. A seat paid after the session gives it after; a seat never paid gives nothing. Cancelled seats and
  no-shows give nothing. Free sessions and a $0 GM fee give nothing.
- the amount is the seat's people × the session's GM fee (`$5` unless the game says otherwise), as "Session done" counts it.
- the 10-minute run does it, with **one store credit for each GM a run** (up to 20 GMs a run), so two sessions over by
  the same run go in one. Shopify emails the GM each time (`notify: true`, as before).
- the team's **GM credit for staff** setting still decides for staff GMs: Never keeps it from them, Always gives it,
  Not in their hours goes by their hours (there's no "they were working" mark for these sessions: their hours decide).
  A kept seat is recorded with no store credit, as "Session done" records it.
- a GM whose tags Shopify couldn't read (and who isn't a helper) isn't paid while the setting could keep it from them:
  the next run tries again.
- a session whose GM has no account in the Lair: staff get one email for each run's seats to add it in Shopify admin.
- sessions from before 26 October keep the staff page's **Session done** button, as before. A round 21 session someone
  credited with Session done before this went live is left alone.

Each seat is recorded in the new table `gm_credit_seats` before Shopify is asked, so a seat is never credited twice:

| status | meaning |
| --- | --- |
| `sending` | with Shopify now. One still `sending` after 30 minutes had no answer (the Lair restarted mid-call): it's `check` |
| `credited` | on the GM's store credit |
| `staff` | kept from a staff GM (amount 0) |
| `manual` | the GM has no account: staff add it in Shopify admin (they got an email) |
| `retry` | Shopify said no, so nothing moved: tried again next run, 5 tries in all |
| `failed` | Shopify said no 5 times: staff got an email to add it by hand |
| `check` | Shopify didn't answer, so it may have gone: never tried again by itself; staff got an email to look |

Each run that decides anything also writes a `credits` row for each session (`by: 'auto'`; status `credited`, `staff`
or `manual`; `players` and `amount` for that run), so My Lair's GM credit list (`GET /me` `credits`) shows each one,
and sets the session's `credited` to the players credited or kept so far. So the staff page's card says "GM credited
for N players", and a session that's had credit keeps its GM (`POST /games/:id/gm` is a 409, as before).

The 10-minute run's record shows `gmCredit: { credited, amount, staff, manual, retry, failed, check }` (players each,
`amount` in cents) when it decided anything.

### `POST /games/:id/credit` for a round 21 session (staff with Money)

There's nothing to tap any more, but the staff page from before this round still shows Session done, so it does now
what the next run would:

- before the session is over: **409** `GM credit adds itself for this session: once it's over, the GM gets their fee
  for each player who's paid. There's nothing to tap.`
- after: **200** `{ players, amount, status, note, auto: true }` for what this tap did: `credited` (with `amount`),
  `staff`, `manual`, `retry`, `failed` or `check` (with that seat's note). When there was nothing to do now, it says
  where the session was already up to (`check`, `failed`, `retry` or `manual` first), or `status: 'none'` with
  `Nothing to add yet: the GM gets their fee for each player once they've paid.` (a seat still to pay, or none at all)
  or `Done: the GM has had their fee for every player who's paid.`
- a cancelled session: 409 `This game was cancelled.`, as before.

### The floor: `gmCredit` (staff with GM games or Money)

For a round 21 session, staff who see GM credit (`creditView`: GM games or Money) get `game.gmCredit` on
`GET /floor`; nobody else does:

```json
{
  "auto": true,
  "credited": { "players": 3, "amount": 1500 },
  "staff": { "players": 0, "amount": 0 },
  "manual": { "players": 0, "amount": 0 },
  "check": { "players": 0, "amount": 0 },
  "failed": { "players": 0, "amount": 0 },
  "retry": { "players": 0, "amount": 0 },
  "toCome": { "players": 1 },
  "unpaid": { "players": 1 }
}
```

- `credited`, `staff`, `manual`, `check`, `failed`, `retry`: players and cents by status (for `staff`, what it would
  have been).
- `toCome`: paid seats not decided yet (the session isn't over, or it's waiting for the next run).
- `unpaid`: players on seats still to pay. Their GM gets theirs once they pay.
- Free sessions, a $0 GM fee and $0 seats count in none of them.

The floor no longer offers `staffGm` (the Session done weighing) for round 21 sessions: `readyForCredit` is false for
them.

## 3. Shopify

`creditCustomer(customerId, cents, currency, { timeout })`: the same `storeCreditAccountCredit` mutation as before. It
now marks an error `refused` when Shopify answered with `userErrors` (or turned the call away before it ran), so nothing
moved, and takes a timeout (20 seconds for the GM credit). Any other error may or may not have moved money, so the GM
credit treats it as `check`. No new access scope.

## 4. What staff should know

- Nothing to tap after a session from today: the GM's credit goes within 10 minutes of the end for each player who has
  paid, and within 10 minutes of each later payment.
- A staff email means something to do by hand: "GM credit to add by hand" (no account, or Shopify said no 5 times), or
  "Check a GM's store credit" (Shopify didn't answer: look before adding any).
- A GM sees each credit in My Lair, and Shopify emails them about it.

# Lair API contract v31: filters on the library shelves and the shop's board games

Round 31, 6 November 2026. Mo approved filters on the library shelves and the shop's board games: **Players, Play time,
Youngest player, Weight, How you play and On the shelf now**, with Library discovery's numbers (Help me pick's facts,
contract v17) copied into Shopify and staff able to correct any game. Shopify's search filters and the theme read them
as product metafields; the Lair keeps them filled.

**Changes only**, on top of every contract before it. Times in ms (UTC), days in Lair time (Pacific/Auckland). Errors
stay `{ error: "A plain sentence." }` with a 4xx or 5xx.

The code: `src/shop-filters.js` (the rules and the runs), with changes in `src/shopify.js` (five calls), `src/lair.js`
(the routes, the alarm, the write hook, maintenance, `heldFor`), `src/core.js` (`heldFor`) and `src/pick.js` (`heldFor`
in the quiz's availability). Tests: `test/round31-library-filters.test.js` (20 checks).

## 1. The fields

Made in Shopify on 6 November 2026, all empty that day; their choices as the Admin API gave them then. Shopify refuses a
value outside the choices, so every value below comes from them.

| Field | Shopify's name | Type and choices | What it says |
| --- | --- | --- | --- |
| `custom.plays_with` | Players (filter) | list of `1 player`, `2 players` … `7 players`, `8+ players` | every count the game plays |
| `custom.play_time_band` | Play time (filter) | list of `Under 30 min`, `30 to 60 min`, `1 to 2 hours`, `2 hours plus` | each band its usual length touches |
| `custom.suits_age` | Youngest player | list of `Age 4`, `Age 6`, `Age 8`, `Age 10`, `Age 12`, `Age 14` | the ages a child can be to play it |
| `custom.how_you_play` | How you play | list of `Co-op`, `Competitive`, `Team`, `Solo` | its mode, plus Solo when it plays with one person |
| `custom.difficulty` | Difficulty (Weight) | one of `Easy`, `Medium`, `Hard` (the field the shop already had) | filled only where it's empty |
| `custom.on_shelf` | On the shelf now | true or false | library games only (section 3) |

### 1.1 Players

Every count from the fewest to the most players; past 8 they're all `8+ players`. 2 to 4: `2 players`, `3 players`,
`4 players`. 1 to 8: `1 player` … `7 players`, `8+ players`. 3 to 10: `3 players` … `7 players`, `8+ players`. 8 to 12,
or 10 to 20: `8+ players`.

### 1.2 Play time

Each band the game's usual length (its time, fewest to most minutes) touches. Under 30 is below 30; 30 to 60 includes
both ends; 1 to 2 hours is over 60 to 120; 2 hours plus is over 120.

| Usual length (minutes) | Bands |
| --- | --- |
| 20 to 29 | Under 30 min |
| 30 | 30 to 60 min |
| 29 to 30 | Under 30 min, 30 to 60 min |
| 60 | 30 to 60 min |
| 60 to 61 | 30 to 60 min, 1 to 2 hours |
| 120 | 1 to 2 hours |
| 120 to 121 | 1 to 2 hours, 2 hours plus |
| 15 to 180 | all four |

A time per chapter counts per chapter: Library discovery's time for a campaign game is a session's (as the tagging work
wrote it), and a listing's "About 20 min per adventure" is 20 minutes.

### 1.3 Youngest player

Each choice at or above the game's youngest age. 3+ or 4+: all six. 7+ or 8+: `Age 8`, `Age 10`, `Age 12`, `Age 14`.
13+ or 14+: `Age 14`. 15+: none, and a value Shopify had is taken off (`metafieldsDelete`: Shopify won't take an empty
list).

### 1.4 How you play

Library discovery's mode (`coop` Co-op, `competitive` Competitive, `team` Team, `solo` Solo), plus `Solo` when its fewest
players is 1. Co-op for 1 to 4: `Co-op`, `Solo`. Competitive for 1 to 5: `Competitive`, `Solo`.

### 1.5 Weight

`custom.difficulty` is filled only where it's empty, from the facts' weight (1.0 to 5.0, BoardGameGeek's scale): Easy
below one cut-off, Hard from another, Medium between. A difficulty that's set is never overwritten, even one that
disagrees with the weight, and a fill only lands while it's still empty (`compareDigest: null`: Shopify refuses it once
someone has set it since the Lair read it).

The cut-offs agree best with the games that already have one: every pair of cut-offs on the weights' one-decimal steps
is tried against the active library games that have both a difficulty (the catalogue's copy of `custom.difficulty`) and
facts a person or the tagging work made (not basic facts, which take their weight from the difficulty), and the pair that
agrees with most wins. Ties go to the pair nearest Help me pick's own (Easy below 2.0, Hard from 3.0), then the lower;
with no games to go by, those. Each run says what it used: `cutoffs: { easyBelow, hardFrom, agree, of }`.

On 6 November a sample of 45 live labels (with the seed's weights) gave Easy below 1.9 and Hard from 3.0, agreeing with
43 of the 45 (Help me pick's 2.0 and 3.0 would agree with 42). The whole library decides it on the first run.

## 2. Where each game's values come from

### 2.1 Library games

Every active library listing (the catalogue: tagged Board Game Rental) whose facts say kind `game` or `expansion`. RPG
books and kind `other` are left alone: never read, never written.

Their values come from the live facts (`pick_facts`: one row a game, and a row staff checked or edited is never
overwritten by the seed or Workers AI, round 17). One exception: a game whose facts are still the basic ones made from its
listing (`source` basic, not checked). Basic facts fill what the listing doesn't say with guesses (players from the shelf
section, 30 to 60 minutes, age 8), so its filters take only what its listing says (2.3). Once staff check it ("Looks
right") or edit it on Check games, its facts count.

### 2.2 The shop's board games

The catalogue's for-sale board games (`pick_shop`: active, product type Board Games, not tagged Board Game Rental; 89 on
6 November). A product sold on a plan (the Board Game Rental Membership) or a gift card isn't a board game: it's skipped
and never listed, leaving the 88 games.

Each takes its library twin's facts, the first of:

1. its own `custom.library_copy`;
2. a library listing whose `custom.shop_copy` is it;
3. the catalogue's own title match ("Catan (Library)" and "Catan" match, as "Buy your own copy" does), an active game
   with checked facts first.

The twin's facts count as 2.1 says. With no twin, its values come from its own listing (2.3). It never gets On the shelf
now.

### 2.3 Reading a listing (never a guess)

Anything a listing doesn't clearly say stays empty, and the game is in the gaps list (2.4).

- **Players** (`custom.players`): "2–4", "2", "1–4 or 6" (1, 2, 3, 4, 6), "3–10+", "8+". "2+" has no top below 8, so it
  can't say every count: empty.
- **Play time** (`custom.play_time`): as it says. "45 min" is 45 (the quiz's "75% of one number" is for its own facts,
  not this), "30–45 min", "1–2 hours", "30 min – 2 hours", "About 20 min per adventure" (20, per chapter), "20 min per
  player" (times each count it plays: 2 to 4 is 40 to 80). "60+ min", "Up to 30 min" and "All day" have no top or bottom:
  empty.
- **Youngest player**: Shopify's category field `shopify.recommended-age-group` (entries of `shopify--recommended-age-group`,
  read by their label). "8 years or older" 8, "13-18 years" 13, months 0, "Teens" 13 (`Age 14`), "Adults" and "18 years
  or older" none, "All ages" all six. With several, the youngest.
- **How you play**: a Co-op tag gives `Co-op`; a Solo tag, or players that include 1, give `Solo`. Competitive and Team
  can't be told from tags, so without a Co-op tag its mode is a gap even when `Solo` is written.
- **Weight**: never from a listing.

### 2.4 The games with gaps

Every run lists, for staff, each game with a field it couldn't fill: `{ productId, title, handle, where: 'library' |
'shop', missing, twin }` (`twin` for shop games: their library twin, or null). `missing` uses the names customers see:
`Players`, `Play time`, `Youngest player`, `How you play` (also when only Solo is known), `Weight` (the difficulty is
empty and there's no facts' weight to fill it). A known "none" (15+, adults only) isn't a gap. Library games come first,
then by title.

Staff correct a library game on Check games. A shop game: link it (its Library copy, or the library game's Shop copy), or
fix its own Players, Play time, age group or tags in Shopify admin; the next run picks it up.

## 3. On the shelf now (`custom.on_shelf`, library games only)

- **True when at least one copy is free now**: copies less active holds (held and not yet ended: members' reserves, their
  queues', postal swaps' and table bookings' alike) less loans out, the sum GET /library/status makes. The copies are the
  catalogue's copy of Shopify's count (synced every 10 minutes for changed listings, all of them every 6 hours), else what
  a library page last sent, else 1, as Help me pick counts them.
- **In Store Only games count the same way**: on the shelf to play at a table while a copy is free, off while it's held,
  and back on once it's collected for a table (round 30: no loan).
- **Within a minute or two**: any change to a library hold or loan (a hold made, cancelled, released, collected or held
  again, a loan made or returned, a queue's or a table booking's hold, an expiry) sets the Durable Object's alarm for a
  minute later, and changes in that minute share it. The alarm also wakes 5 seconds after the next active hold ends (a
  hold stops counting at its end, before maintenance marks it expired). Each run works out every game's value; where it
  differs from what the Lair last saw in Shopify (`shelf_state`), Shopify is read first and only what's different written,
  100 games a run and as far as the invocation's calls go (section 9; more: the alarm again a minute later). A game
  Shopify doesn't have is set aside until the nightly run, so it's never asked about every minute.
- **Never in the way**: a borrow, hold or return is saved and answers as before; Shopify is only asked afterwards, by the
  alarm. When Shopify fails it's tried again 1, 2, 5, 15 and 30 minutes later, then hourly, until it answers. Maintenance
  (every 10 minutes) does the same work as the alarm's safety net.
- **The alarm itself** (from the review): a Durable Object has one. A wake never moves a sooner one that's already set;
  after an eviction the Lair doesn't remember what's set, so its first wake asks Cloudflare (`getAlarm`) and keeps the
  sooner. When the alarm goes off but fails before its work starts (the Lair's settings can't be read), it's set again 5
  minutes on.
- **Every night** each game's value is read from Shopify and put right where it drifted (someone changed it by hand).

## 4. When the filters are written

| When | What |
| --- | --- |
| Soon after the deploy (the first fill): the first maintenance once the Lair has never finished a whole run, not waiting for 3am | a whole run: every library game and shop board game, the four filters, Weight where it's empty, On the shelf now |
| Every night, at the first maintenance from 3am Lair time, once a Lair day | a whole run |
| Staff press the button (5.1) | a whole run, or the one under way taken further |
| Straight after staff save a game on Check games (`POST /pick/games/:productId`, its answer unchanged) | that game and its shop twins (its Shop copy, the shop games with its title, and those whose Library copy is it): the alarm 5 seconds later. One that fails is tried again 1, 2, 5, 15, 30 and 60 minutes later, then left to the nightly run after 10 tries. |
| A hold or loan changes | On the shelf now (section 3) |

**A whole run goes a slice at a time** (from the review): it starts with every product to do (meta `shop-filters-run`),
and each invocation (maintenance, the alarm, the button) takes it as far as its calls go (section 9), a slice of up to 50
products sized so its read and writes fit, saved after each. A game it settles leaves the run: written, already right, or
refused by Shopify on its own (2 below). One it couldn't finish (the calls ran out, or Shopify didn't answer) stays first
in line, read again next time. While any are left, the alarm takes it on a minute later in a fresh invocation (later
after failures in a row: 1, 2, 5, 15, 30, then 60 minutes); maintenance starting a run uses only what its own invocation
has left. A run is finished only when nothing's left: then its summary is kept for GET /pick/filters, and a night's run
marks that Lair day done (so the night's run never counts as done with games still to write). One run at a time: while
one's under way no other starts, and the alarm, maintenance and the button wait for each other.

**Only what changed is written.** Shopify is read first (`LairFilterProducts`, 50 products a read), and a field is
written only when Shopify doesn't already have that value (lists compared in Shopify's order). Writes are `metafieldsSet`,
25 fields a call with a game's fields together (Shopify's limit), and `metafieldsDelete`, 25 a call, to take off a list
that's now known to be empty. Every call is paced by Shopify's query bucket, and one that's throttled is asked again once
there's room (5 tries, each a call).

**A refusal fails only its own game** (from the review). `metafieldsSet` is all or nothing, so when Shopify turns away a
call with more than one game in it (say a librarian set a game's difficulty just after the Lair read it, so that fill is
refused), the call is split in halves, and halves again, down to single games, so the game Shopify refuses is on its own:
only it counts as failed (tried again the next night), and every game beside it is written. Splitting spends calls from
the same budget; what the budget doesn't reach waits for the next invocation.

## 5. Staff routes

### 5.1 `POST /pick/filters` (perm library, as Sync with Shopify now)

A whole run (or the one under way) taken as far as this request's calls go (section 4). → 200. Finished, for example:

```json
{ "done": true, "at": 1794189000000, "finishedAt": 1794189004000, "reason": "staff", "games": 638, "changed": 12, "fields": 31, "failed": 0,
  "gaps": [], "cutoffs": { "easyBelow": 1.9, "hardFrom": 3, "agree": 431, "of": 450 }, "message": "12 games changed in Shopify." }
```

Not finished yet (the first fill, say), with the alarm taking on the rest a minute later:

```json
{ "done": false, "total": 638, "checked": 149, "left": 489, "changed": 149,
  "message": "149 of 638 games done so far, 149 changed in Shopify. The rest follow in the next few minutes." }
```

- `games`: the products looked at (library games and shop board games); `changed`: the games with a field written or
  taken off; `fields`: how many; `failed`: the games Shopify refused (tried again tonight); `gaps` (2.4); `cutoffs` (1.5);
  `checked`: the games done so far, of `total`.
- `message`: what changed, then what failed and what's missing, when there's any; or how much is done and that the rest
  follows (section 7).
- 403 without the library permission. 503 with the reason: Shopify not connected, the app without `write_products`, or
  Shopify not answering before anything was done (section 7); a run it started stays under way, for the alarm.

### 5.2 `GET /pick/filters` (perm library)

`{ last: { at, finishedAt, reason: 'first' | 'nightly' | 'staff', games, changed, fields, failed } | null, gaps, cutoffs,
running: { reason, startedAt, total, checked, left, changed } | null }`: the last whole run that finished, its gaps and
cut-offs, and the run under way.

### 5.3 What the staff page needs (the theme, not this branch)

On Help me pick › Check games, beside Sync with Shopify now: a button **Write the filters to Shopify now** (`POST
/pick/filters`, showing its `message`), and the games with gaps (`GET /pick/filters`'s `gaps`: title, where, what's
missing), each linking to the game on Check games (library) or in Shopify admin (shop).

## 6. `GET /library/status`: who it's held for

Additive: each game also says `heldFor`, who its soonest-ending active hold is for: `'table'` (a game held for a table
booking, round 17), `'member'` (a member's reserve, their queue's or a postal swap's), or `null` with no active hold.
Every other field is as it was. With `nextFree` (when no copy is free) a page can say "Held for a table until 9pm" or
"Reserved until Thursday".

```json
{ "games": { "50475429855335": { "copies": 1, "held": 1, "out": 0, "available": 0, "nextFree": 1794211200000, "mine": null, "atHome": null, "heldFor": "table" } } }
```

(For example: held for a table booking that ends at 9pm on Monday 9 November 2026.)

The quiz's cards (`availability`, contract v17) say the same.

## 7. Messages, word for word

| Where | Words |
| --- | --- |
| The button, something changed | `<n> games changed in Shopify.` (`1 game changed in Shopify.`) |
| The button, nothing to change | `Every game's filters were already up to date.` |
| …and when Shopify turned some away | `<n> games couldn't be written just now: the Lair tries again tonight.` (`1 game couldn't …`) |
| …and when some have gaps | `<n> games are missing something: they're listed below.` (`1 game is …`) |
| The button, a run not finished yet | `<checked> of <total> games done so far, <changed> changed in Shopify. The rest follow in the next few minutes.` |
| 503, Shopify not connected | `Shopify isn't connected yet, so there's nothing to write.` |
| 503, no `write_products` | `Shopify hasn't let the Lair app change products yet (write_products), so the filters can't be written.` |
| 503, Shopify not answering | `Shopify didn't answer just now. Try again in a minute.` |

## 8. Storage

Made when missing on every start, and written only when something changes:

- `shelf_state` (`product_id`, `on_shelf`, `at`): what Shopify's On the shelf now says for each library game, as the Lair
  last read or wrote it.
- `filter_queue` (`product_id`, `due_at`, `tries`, `error`): games staff saved, waiting for the alarm (and those waiting to
  try again).
- `shop_twins` (`shop_id`, `library_id`, `seen_at`): shop games linked by their own Library copy, as last read, so a save
  finds them.
- `meta`: `shop-filters-run` (the whole run under way: its products still to do, its counts and gaps so far, rewritten
  after each slice), `shop-filters-last` (the last whole run that finished) and `shop-filters-day` (the Lair day the
  last night's run finished for).
- An index on `library_holds (status, until)`: the alarm and maintenance ask for the holds still on every few minutes,
  and the table keeps every hold ever made, so those reads only touch the active ones (the free plan counts rows read).

## 9. Shopify permissions and limits

- **Nothing new for Mo to approve.** Reading needs `read_products` (products and their fields) and `read_metaobjects`
  (the age groups' labels), both granted. Writing needs `write_products` (`metafieldsSet` and `metafieldsDelete` on
  products), granted for round 26's GW order pad; the health check's optional permissions now say the filters use it
  too, and without it the runs don't start and the button says why.
- The fields are in the store's own namespace (`custom`), so the app may write them with `write_products`.
- Shopify: 50 products a read (checked against the live store on 6 November: well under the 1,000 a query), 25 fields a
  write, every call paced by the query bucket.
- **Cloudflare's free plan: 50 outside calls an invocation** (from the review). Every request to Shopify (its API and its
  login), an event picture's upload and Resend is counted as it's made (`externalCalls` in `src/shopify.js`). Each
  invocation (a request to the Lair, maintenance's run, the alarm) notes the count when it begins, and the filters make
  at most 35 calls less whatever the invocation made before theirs; past that they stop cleanly and the rest waits for
  the alarm, a minute on, in a fresh invocation with its own 50 (section 4). The 15 left over cover a login, an email or
  a retry. The count is shared by whatever runs at once, so it can only stop early, never late.
- Cloudflare's SQLite: no query binds more than a handful of values, and the whole-table reads (holds, loans,
  `shelf_state`, the catalogue's difficulties) have no `IN` lists.

## 10. Tests

`test/round31-library-filters.test.js`, 20 checks named for the rules, against a pretend Shopify that refuses what the real
one does (values outside the choices, an empty list, the wrong type, more than 25 fields a call, a fill over a set
difficulty) and counts every call as an outside one, with every invocation held to the free plan's 50; each seen
failing for the right reason before the change, and each rule broken once afterwards to see its check fail. Five of
them came from the review: a fill too big for one invocation, the night's run inside maintenance, a refusal isolated,
the alarm's retry, and the alarm after an eviction. The older checks that pin GET /library/status's exact shape (`test/lair.test.js`, `test/round7-a.test.js`)
and a quiz card's (`test/round17-pick.test.js`) now expect `heldFor` too: the new field, not a changed rule.

## 11. Going live

1. The Lair, with Mo's yes (a push to `main` deploys it). Nothing to approve in Shopify.
2. The first fill starts by itself at the first maintenance after the deploy (within 10 minutes): about 550 library
   games and 88 board games, roughly 3,000 fields in about 120 calls plus 13 reads, so about four or five invocations of
   35 calls, the alarm taking it on a minute apart: done in five minutes or so. On the shelf now fills alongside, 100
   games a go. The button shows how far it's got (or GET /pick/filters's `running`).
3. Then check the gaps list: link shop games to their library copies and fix the listings it names.
4. The website, not in this branch: in the Search & Discovery app add the six filters (Players (filter), Play time
   (filter), Youngest player, Difficulty, How you play, On the shelf now) to the library's collections and the board
   games collection (Difficulty can show as "Weight" there), and the staff page's button and gaps list (5.3). Library
   pages can use `heldFor`.

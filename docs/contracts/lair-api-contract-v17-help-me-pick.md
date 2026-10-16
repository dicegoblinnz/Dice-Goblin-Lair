# Lair app API: round 17, Help me pick [pick] (16 Oct 2026)

**Changes only**, on top of v16-wishlist and everything before it; where they disagree, this file wins. Times in ms
(UTC) unless a field says otherwise. Errors stay `{ error: "A plain sentence." }` with a 4xx. Money in cents (NZD).

Branches: backend `r17-main` (built on `r17-pick` and `r17-queue`), theme `r17-theme` off `dice-goblin-2-theme` (built
on `r17-quiz`, `r17-member` and `r17-staff`). Nothing ships to `main` (production) until Mo says.

Mo's spec (the doc "Help me pick: game finder spec", 16 Oct 2026) is the source of every rule here. In short: a quiz
that takes anyone from "what should we play?" to three good library games plus a wildcard in about 30 seconds, for
playing here or for borrowing; four doors into it; taps, an optional swipe round, picks, fine-tune; a borrow queue that
works old-school Netflix style; a game attached to a table booking held from 3 days before; ratings, member taste, a
demand report and pick tracking; every library game tagged by Claude and checked by staff; new games tagged by
themselves. Mo's decisions on the open questions (16 Oct, 1:41pm):

- Postal queue: the next game is held until the Wednesday 10pm cutoff, then goes back on the shelf, still in their queue.
- In-store queue: an uncollected auto-hold doesn't trigger the next one, so holds don't stack up.
- Staff picks: shown as "Staff pick", no names.
- Wildcard: nudges (staff picks, underplayed, new arrivals) only break ties and fill the wildcard.
- Player types: plain names and plain wording (no goblins, no jokes): Party player, Thinker, Team player, Competitor,
  Adventurer, Chill player.
- "Add more games later": new library games join the quiz by themselves, tagged automatically and put on the staff
  check list. Nothing is reprogrammed.

Gobgob speaks only on the results (each pick's reason line); the questions are plain. NZ spelling everywhere.

---

## 1. The games: catalogue, facts and the seed

### 1.1 The catalogue (`pick_catalog`), synced from Shopify

The Lair keeps its own copy of every library listing, so the quiz never waits on Shopify. A library listing is an
active product tagged `Board Game Rental` (there are 680 on 16 Oct). One row per product:

| Column | What |
| --- | --- |
| `product_id` (PK) | the product's digits |
| `variant_id` | its first variant's digits |
| `handle`, `raw_title` | as Shopify has them |
| `title` | `raw_title` without a trailing " (Library)" (any case, with or without the space) |
| `image` | the featured image's URL, or null |
| `shelf_code` | `custom.library_code`, upper case, or null |
| `copies` | the variant's `inventoryQuantity` when tracked and ≥ 1 (capped 99), else null (callers fall back as `shopifyCopies` does) |
| `in_store_only` | 1 when a tag's handle is `in-store-only` (the theme's rule) |
| `missing_pieces`, `missing_note` | `custom.missing_pieces` (true → 1) and `custom.missing_pieces_note` |
| `tags` | JSON array of the product's tags |
| `players_text`, `time_text`, `difficulty` | `custom.players`, `custom.play_time`, `custom.difficulty` as typed |
| `blurb` | `global.description_tag` with a leading "Borrow <anything> at Dice Goblin." taken off, trimmed, else null |
| `video` | the first `youtube.com/watch?v=…` or `youtu.be/…` link in `descriptionHtml` (a YouTube search link doesn't count), else null |
| `vendor` | the product's vendor |
| `created_at_shopify`, `updated_at_shopify` | ms |
| `status` | `active`, or `gone` once a full sync no longer sees it (archived, deleted, untagged) |
| `seen_at`, `synced_at` | ms |

**Sync** (`syncCatalog`): Admin GraphQL `products(first: 100, sortKey: ID, query: "tag:'Board Game Rental' AND
status:active")`, paged. A **full sync** reads every page and marks rows not seen as `gone`; it runs on the first
maintenance after the Lair starts, then once every 6 hours. Between those, an **update sync** reads only
`updated_at:>'<last sync minus 5 minutes>'` every maintenance run (10 minutes). Both are skipped while Shopify isn't
configured or `read_products` isn't granted (the `copies` back-off applies). Never throws: errors go to `note({
catalogError })`. Staff can run a full sync now with `POST /pick/sync`.

**Shop copies** (`pick_shop`): the for-sale board games, so a pick can say "Buy your own copy". Same sync, query
`product_type:'Board Games' AND -tag:'Board Game Rental' AND status:active`, keeping `product_id`, `handle`, `title`,
`norm` (the matching key below), `price` (cents, the lowest variant price), `available` (total inventory > 0, or any
variant available for sale), `image`. A library game's shop copy is the available row whose `norm` equals the game's
`norm`. `norm` = lower case, "(library)" and any bracketed edition words removed, "&" → "and", accents dropped, every
run of non-letters-or-digits → one space, trimmed. (The shop only shows products in stock, so an unavailable copy is
never linked.)

### 1.2 Facts (`pick_facts`)

One row per product: `product_id` (PK), `facts` (JSON, the shape below), `source` (`seed` | `basic` | `auto` |
`staff`), `checked` (0/1), `checked_by`, `checked_at`, `staff_pick` (0/1), `seed_version`, `ai_tries`, `ai_error`,
`created_at`, `updated_at`.

```json
{
  "kind": "game",
  "players": { "min": 2, "max": 5, "best": [4] },
  "time": { "min": 45, "max": 60 },
  "weight": 2.3,
  "age": 10,
  "mode": "competitive",
  "vibes": ["thinky"],
  "themes": ["history", "trains"],
  "styles": ["route-building", "set-collection"],
  "reading": "light",
  "access": { "colourBlind": null, "easyPieces": false },
  "table": "single",
  "expansionOf": null,
  "rpg": null,
  "summary": "Build train routes across a map and connect the cities on your tickets.",
  "confidence": "high"
}
```

The words allowed for `kind`, `mode`, `vibes`, `themes`, `styles`, `reading`, `table`, `confidence` and `rpg.type` are
the vocabulary in `src/pick-vocab.js` (`PICK_VOCAB`, copied from the tagging work's `vocab.json`). `weight` is 1.0–5.0
(one decimal, BoardGameGeek's scale). `expansionOf` is the base game's `product_id` (the seed resolves the taggers'
`expansionOfTitle` to it) or null. `rpg` is `{ system, starter, setting, type }` for `kind: rpg`, else null. A row
failing validation (`validFacts`) is never saved: staff get a 422 naming the field.

**Where facts come from, in order:**

1. **The seed** (`src/pick-seed.js`: `PICK_SEED_VERSION` and `PICK_SEED`, keyed by product id), written by Claude from
   the 16 Oct tagging of all 680 games. Applied when the Lair starts and `meta` key `pick-seed` is older than
   `PICK_SEED_VERSION`: a product with no row gets one (`source: 'seed'`); a row still `seed` and not checked takes the
   new facts; anything a person has touched (`checked = 1` or `source: 'staff'`) is never overwritten. One run per
   version, in one transaction-shaped pass (no awaits).
2. **Basic facts** for a catalogue product with no row (a game added after the seed): made at once from the listing
   (`basicFacts`): players from `players_text` ("2–4", "2-4", "1–6+", "2+" → max 99 is wrong: "2+" → max min+4),
   best = the middle count; time from `time_text` ("20 min", "60–90 min", "1–2 hours"); weight from `difficulty`
   (Easy 1.5, Medium 2.5, Hard 3.5, else 2.0); age from the tags/blurb ("ages 8+") else 8; mode `coop` when a tag is
   Co-op/Cooperative, else competitive; vibes from tags (Party → laughs, Co-op/Family → chill, Strategy → thinky, else
   thinky); themes/styles from tags that match the vocabulary words, else `["abstract"]`/`["set-collection"]`; reading
   `some`; access nulls; table single; kind `expansion` when the title says Expansion (expansionOf null), `rpg` when
   the shelf code starts DGLRPG, else game; summary = the blurb's first sentence (≤ 140) or "<Title>, from the
   library."; confidence `low`. `source: 'basic'`, `checked: 0`.
3. **Auto facts** (Workers AI, `autoTag`): each maintenance run takes up to 5 rows that are `basic` with `ai_tries < 3`,
   oldest first, and asks the AI binding for the whole facts object from the title, vendor, tags, the listing's
   fields and the description's text (HTML stripped, first 1,500 characters). The answer must pass `validFacts` (after
   clamping numbers into range and dropping unknown words); then `source: 'auto'`, `confidence` as given (never
   `high`), `checked: 0`. A failure adds 1 to `ai_tries` and keeps `ai_error`; the basic facts stay. Model: config
   `PICK_AI_MODEL`, default `@cf/google/gemma-4-26b-a4b-it` (use JSON mode, `response_format: { type: 'json_schema',
   json_schema }`, and `chat_template_kwargs: { enable_thinking: false }` where the model supports it; check the
   Workers AI docs for a model that supports JSON mode and use that if this one doesn't). Config `PICK_AI` = `off`
   stops it. No AI binding (tests, local dev) → it's skipped. Never throws.
4. **Staff** edits (`POST /pick/games/:id`): `source: 'staff'` when the facts changed, `checked: 1` with who and when.

`wrangler.toml` gains `[ai] binding = "AI"`.

### 1.3 Famous games (`src/pick-known.js`)

`PICK_KNOWN`: about 120 well-known games (Monopoly, Uno, Catan…) with `title`, `aliases` and the matching fields
(players, time, weight, age, mode, vibes, themes, styles). Only used for "Games you already love" and its search.

---

## 2. How the quiz matches

All of this runs in the Lair (`src/pick.js`, no Shopify calls while matching). A game is a catalogue row that's
`active` with facts. `kind: other` is never a pick; `expansion` never a pick (it shows as an add-on, 3.4);
`rpg` only in the roleplaying branch.

### 2.1 What the quiz sends

```json
{
  "mode": "play",
  "players": 4,
  "kids": true,
  "youngest": 6,
  "time": "medium",
  "brain": "some",
  "team": "either",
  "vibes": ["laughs"],
  "filters": { "themes": ["spooky"], "loves": [{ "productId": "7498…" }, { "known": "Monopoly" }], "lightReading": false, "colourBlind": false, "easyPieces": false, "hideHad": false },
  "swipes": { "7498129866855": "like", "7498129899623": "nope", "7498130063463": "skip" },
  "rpg": null,
  "context": { "door": "library", "table": null, "bookingId": null, "date": null },
  "useTaste": true
}
```

- `mode`: `play` (here at the Lair), `borrow`, or `rpg` (the try-roleplaying branch).
- `players`: 1–8 (8 is "8 or more"). `kids`: whether kids are playing; `youngest`: 2–17 when they are.
- `time`: `short` (under 30 minutes), `medium` (30–60), `long` (1–2 hours), `epic` (longer).
- `brain`: `easy` (weight under 2.0), `some` (2.0–2.9), `big` (3.0 and up).
- `team`: `coop`, `competitive` or `either`. `vibes`: any of `chill`, `laughs`, `thinky`, `cutthroat` (none is fine).
- `filters.themes`: theme groups (2.6). `filters.loves`: up to 5, each a library `productId` or a famous game's title.
- `rpg` (mode `rpg` only): `{ "tried": "never" | "some" | "lots", "players": 1–8, "setting": "<theme>" | "any", "gm": "lair" | "own" }`.
- `context.door`: `library`, `collection`, `booking`, `kiosk`, `table`, `page`, `my-lair` or `share`. `table`: a table
  code like `T14` (the table QR). `bookingId` and `date` (`YYYY-MM-DD`): the booking door.
- `useTaste`: a logged-in member's saved taste joins in (2.4).

Anything missing or out of range falls back to "not asked" (players 4, time any, brain any, team either), never a 422,
so an old page or a half-filled quiz still gets picks.

### 2.2 Hard rules (a game must pass all)

1. **Kind**: `game` for play and borrow; `rpg` for the roleplaying branch.
2. **Players**: `min ≤ players ≤ max` (8 means `max ≥ 8`). RPG: `rpg.players` within min..max.
3. **Time**: short → `time.min ≤ 35`; medium → `time.min ≤ 70` and `time.max ≥ 25`; long → `time.min ≤ 135` and
   `time.max ≥ 45`; epic → `time.max ≥ 90`.
4. **Age**: with kids, `age ≤ youngest`.
5. **Availability** (play mode only): at least one copy free for them to play on the day (2.5).
6. **Filters**: `lightReading` → `reading = 'light'`; `hideHad` (logged in) → never borrowed by them (any
   `library_loans` row); a game the member rated thumbs down is out; a game nope'd in this quiz's swipes is out.
   `colourBlind` and `easyPieces` are soft (2.3), because most games' answers are unknown.

### 2.3 Score (higher is better; only the order matters)

| Signal | Points |
| --- | --- |
| Their player count is in `best` | +12 (else +4 for just fitting) |
| Time sits inside their bucket (whole range) | +10; overlapping only +4 |
| Brain: weight inside their range | +15; per 0.5 outside it −6 |
| Team: coop asked, game coop | +15; game team +4; game competitive −15 |
| Team: competitive asked, game competitive or team | +8; game coop −10 |
| Each vibe asked that the game has | +8 (at most +16); chill asked and game cutthroat −8; cutthroat asked and game chill −4 |
| Swipes: like | +20 × the best similarity to a liked game (the liked game itself +10 more) |
| Swipes: nope | −12 × the best similarity to a nope'd game |
| Loves (fine-tune) | +20 × the best similarity to a loved game (library or famous) |
| Theme groups chosen (fine-tune) | +20 when any of its themes is in a chosen group, else −10 |
| colourBlind asked | +6 when `true`, −20 when `false`, 0 when unknown (same for easyPieces) |
| Member taste (useTaste) | +10 × best similarity to their past likes and thumbs up, −8 × to their thumbs down |
| Their own thumbs up | +5 |
| Members' ratings | +6 × (ups − downs) / (ups + downs + 3) |
| Kids 7 and under, game on a DGLF shelf | +5 |
| Borrow mode, game stays in store | −10 |
| Nudges: staff pick, underplayed, new arrival | +1 each (tie-breakers only; see 2.7) |

Similarity of two games (0–1): 0.35 × Jaccard(styles) + 0.25 × Jaccard(themes) + 0.2 × Jaccard(vibes) + 0.1 × (1 −
|weight difference| / 4) + 0.1 × (same mode).

**Underplayed**: catalogued at least 30 days and no hold or loan in the last 90 days. **New arrival**: Shopify
`created_at` in the last 60 days.

### 2.4 Member taste (`pick_taste`)

One row per logged-in member: `likes` and `nopes` (product ids from their swipes, the last 50 each), `answers` (their
last core answers), `player_type`, `updated_at`. Saved on every `POST /pick` by a logged-in member. With `useTaste`,
their likes and thumbs-up games count as likes at half weight (the table's taste row), and the quiz may skip the swipe
round (`GET /me/picks` says `taste.has` when there are 3 or more likes or rated games).

### 2.5 Availability

A copy's free for a window when `copies − active holds − games at home ≥ 1`, where holds include booking holds (5.2)
whose window overlaps, and copies are the catalogue's (then the rules `libraryStatus` uses). Play mode with no booking:
free right now. The booking door (`context.bookingId` or `date`): free now, and no booking hold for the same copy
overlaps that booking. Borrow mode never filters; each card says how it stands (3.3).

### 2.6 Theme groups (fine-tune chips)

`fantasy` (fantasy, mythology), `scifi` (sci-fi, space), `spooky` (spooky, horror), `mystery` (mystery, crime),
`history` (history, war), `nature` (nature, animals, farming), `cute` (cute), `food` (food), `adventure`
(adventure, pirates), `travel` (travel, trains, city), `heroes` (superheroes, film-tv), `abstract` (abstract),
`words` (words), `funny` (humour), `sports` (sports), `science` (science, art). The quiz shows these as chips; the
Lair maps them.

### 2.7 Picking three and a wildcard

1. Score every game that passes the hard rules. **fitCount** = how many passed.
2. **Too few** (fewer than 4): loosen in this order until at least 4 pass, and list what was loosened in `relaxed`:
   `time` (any time), `filters` (lightReading, hideHad), `availability` (play mode: reserved and out games come back,
   marked), `players` (the closest min/max). Age and kind are never loosened. Still none → `picks: []`.
3. **Top three**: highest score first, but a candidate is skipped when its similarity to a pick already chosen is over
   0.85 or it shares the first two words of its title with one (the same series), while another candidate within 85%
   of its score is left. Ties break by nudges (staff pick, underplayed, new), then title.
4. **Wildcard**: from the candidates ranked 4th to 30th, those with similarity under 0.6 to every top pick; among
   them the nudged ones first (staff pick, underplayed, new arrival), then by score; choose one with a random number
   seeded by the session id and the request count, so it changes on "Show me different picks" but not on a page
   refresh. None → the 4th best. Fewer than 4 candidates → no wildcard.
5. **Why** (2.8) for each, then the cards (3.3).

### 2.8 Why it matched (`why`)

Each pick carries up to 3 reasons, strongest first, for the theme to turn into Gobgob's one line:
`{ code: 'best-at', n }`, `{ code: 'players', n }`, `{ code: 'time', min, max }`, `{ code: 'brain', value }`,
`{ code: 'coop' }`, `{ code: 'competitive' }`, `{ code: 'team' }`, `{ code: 'vibe', vibe }`, `{ code: 'like', title }`
(similar to a game they liked or love), `{ code: 'theme', group }`, `{ code: 'kids', age }`, `{ code: 'rated', ups }`
(3 or more members gave it a thumbs up), and for the wildcard one of `{ code: 'staff-pick' }`, `{ code: 'new' }`,
`{ code: 'underplayed' }`, `{ code: 'stretch' }`.

### 2.9 Player type

`party`, `thinker`, `team`, `competitor`, `adventurer` or `chill`. Points: each vibe asked +2 to its type (laughs →
party, thinky → thinker, cutthroat → competitor, chill → chill); team coop +3 → team; competitive +1 → competitor;
each liked swipe +1 by its styles (party, dexterity, drawing, word, trivia, hidden-roles → party; puzzle,
engine-building, abstract, worker-placement, economic → thinker; area-control, take-that, auction, negotiation →
competitor; campaign, storytelling, dungeon-crawl → adventurer; tile-laying, pattern-building, set-collection →
chill) and by its themes (adventure, fantasy, mythology, pirates → adventurer). Highest wins; ties in the order team,
party, thinker, competitor, adventurer, chill. The roleplaying branch is always `adventurer`. The theme shows the
names and lines (plain words, Mo's choice).

### 2.10 The roleplaying branch

Only `kind: rpg`. Hard rules: players within min..max. Score: setting matches +15; `tried: never` → `rpg.starter`
+20, type starter +12, core +8, adventure −5, supplement −15, setting −10; `tried: some` → core +8, adventure +6,
starter +4; `tried: lots` → adventure +8, supplement +4, setting +4; `gm: lair` adds nothing here (the theme shows
"Book a TTRPG session" either way, first when `gm: lair`). Top 3 + wildcard as 2.7, player type `adventurer`.

---

## 3. Quiz routes (`src/pick.js`)

All through the app proxy (`/apps/liar/pick…`). "Anyone" means no login needed. A rate limit of 60 quiz requests per
connection (`X-Lair-Client`) in 10 minutes covers `POST /pick`, `/pick/swipes`, `GET /pick/known` and `/pick/game`
(429 `busy`).

### 3.1 `POST /pick` (anyone)

Body: 2.1 plus `sessionId?` and `editKey?`. With a matching `sessionId` and `editKey` the session is updated (the next
fine-tune, "Show me different picks" with `again: true`); otherwise a new one is made.

→ `{ session: { id, editKey }, mode, picks: [card, card, card], wildcard: card | null, playerType, fitCount, relaxed,
answers }` (`answers`: what was used, after fallbacks). `id` is 10 characters and `editKey` 20, both from
`crypto.getRandomValues` (letters and digits, no look-alikes), so a shared link can't be guessed or edited.

### 3.2 `POST /pick/swipes` (anyone)

Body: 2.1's `mode`, `players`, `kids`, `youngest`, `time`, `context`, and `sessionId?`. → `{ candidates: [mini × 8] }`:
eight games that pass the hard rules, as different as possible (spread over vibes, themes, styles and weight; better
known first: high confidence and a picture), never one they rated down. `mini` = `{ productId, title, image, summary,
players, time, weight }`. Fewer than 8 pass → as many as there are.

### 3.3 The card

```json
{
  "productId": "7498…", "variantId": "4211…", "handle": "catan-library", "title": "Catan", "image": "https://cdn.shopify.com/…",
  "summary": "…", "blurb": "…",
  "shelfCode": "DGL34-M011", "shelf": { "section": "DGL34", "size": "M", "number": 11 },
  "players": { "min": 3, "max": 4, "best": [4] }, "time": { "min": 60, "max": 90 }, "weight": 2.3, "brain": "some",
  "age": 10, "mode": "competitive", "vibes": ["thinky"], "themes": ["…"], "reading": "some",
  "access": { "colourBlind": null, "easyPieces": false }, "table": "single",
  "video": "https://www.youtube.com/watch?v=…" ,
  "inStoreOnly": false, "missingPieces": false, "missingNote": "",
  "availability": { "copies": 2, "available": 1, "held": 0, "out": 1, "nextFree": null, "mine": null, "atHome": null },
  "staffPick": false, "isNew": false, "underplayed": false,
  "addOns": [{ "productId": "…", "title": "Catan: Seafarers", "handle": "…", "available": 1 }],
  "shopCopy": { "handle": "catan", "title": "Catan", "price": 7999 } ,
  "why": [{ "code": "best-at", "n": 4 }, { "code": "time", "min": 60, "max": 90 }],
  "rpg": null
}
```

`shelf.size` is null for RPG books (DGLRPG-021). `availability` is `libraryStatus`'s shape for that one game (with
`mine` and `atHome` for the logged-in member). `addOns`: library expansions whose `expansionOf` is this game. `shopCopy`
is null when there's no available shop copy. `video` falls back to null; the theme then links a YouTube search.

### 3.4 `GET /pick/:id` (anyone)

A shared session: → `{ session: { id }, mode, picks, wildcard, playerType, answers, createdAt }` with availability
worked out now. 404 `gone` when there's no such session. Sessions are kept 180 days.

### 3.5 `GET /pick/known?q=` (anyone)

"Games you already love": `q` 2–60 characters → `{ games: [{ key, title, productId | null }] }`, up to 8: library
titles and famous titles (and aliases) that start with or contain `q` (case and accents ignored), library first,
no duplicate titles. `key` is the productId, or `known:<title>`.

### 3.6 `GET /pick/game/:productId` (anyone)

One library game as a card (no `why`): for the booking page's game chip and the staff page. 404 `game` when it isn't
an active library game.

### 3.7 `POST /pick/:id/event { action, productId?, editKey? }` (anyone)

Pick tracking. `action`: `view`, `reserve`, `queue`, `book`, `buy`, `shelf`, `save`, `share`, `email`, `video`,
`more`, `watch`, `again`, `swipe-skip`. Unknown actions and unknown sessions are ignored (`{ ok: true }` anyway).
At most 50 events a session. Table `pick_events` (`session_id`, `product_id`, `action`, `created_at`).

### 3.8 `POST /pick/:id/save { editKey }` (logged in)

Keeps the session on their account (My Lair's saved picks). → `{ ok: true, saved }` (`saved`: their last 5, as
`GET /me/picks` has them). 401 `login`, 404 `gone`, 403 `notYours` (wrong edit key).

### 3.9 `POST /pick/:id/email { email, editKey }` (anyone)

Emails the picks (title, picture, the reason line's facts, a link to each game and to the shared picks) to that
address. At most 3 a session and 10 an hour a connection (429 `busy`); 422 `email` for an address that doesn't look
right; 404 `gone`; 403 `notYours`. → `{ ok: true }`. The newsletter tick is the theme's: it signs them up through
Shopify's own customer form, never through the Lair.

### 3.10 Sessions (`pick_sessions`)

`id` (PK), `edit_key`, `customer_id` (null for guests; set when a logged-in member makes or saves it), `saved` (0/1),
`door`, `mode`, `table_code`, `booking_id`, `answers` (JSON, 2.1 without `context`), `picks` (JSON: the 3 product ids),
`wildcard` (product id), `player_type`, `fit_count`, `relaxed` (JSON), `requests` (how many times it was asked),
`emails`, `created_at`, `updated_at`. Guests' sessions keep no personal details. Sessions older than 180 days that
aren't saved are deleted by maintenance.

---

## 4. Ratings (`game_ratings`)

`customer_id` + `product_id` (PK), `rating` (1 or −1), `source` (`return`, `page`, `pick`), `created_at`,
`updated_at`.

- `POST /library/rate { productId, rating: 'up' | 'down' | null, source? }` (logged in) → `{ ok: true, productId,
  rating }` (null clears it). 401 `login`; 422 `product` for anything that isn't a library game in the catalogue.
- `GET /me/picks` (logged in) → `{ saved: [{ id, createdAt, playerType, picks: [{ productId, title, handle, image }] }]
  (last 5, newest first), taste: { has }, toRate: [{ loanId, productId, title, handle, image, returnedAt }],
  ratings: { [productId]: 'up' | 'down' } }`. `toRate`: their games back on the shelf in the last 30 days that they
  haven't rated, newest first, at most 5.

---

## 5. Borrowing: the queue, postal sends, "tell me when it's back", and booking holds (`src/queue.js`)

### 5.1 The borrow queue (`library_queue`, `library_queue_settings`)

`library_queue`: `id`, `customer_id`, `product_id`, `variant_id`, `title`, `handle`, `image`, `shelf_code`,
`position` (1, 2, 3… within the member's queue), `status` (`queued`, `held`, `done`, `removed`), `hold_id`,
`added_at`, `updated_at`. A product is queued once per member while `queued` or `held`.

`library_queue_settings`: `customer_id` (PK), `paused` (0/1), `delivery` (`store` | `post`, default `store`), `area`
(`auckland`, `auckland-rural`, `nationwide`, `nationwide-rural`, or null), `stalled` (0/1), `stalled_reason`,
`stalled_at`, `updated_at`.

Rules:
- **Library members** with a plan (`planOf`) queue up to 30 games. Not an in-store-only game (422 `inStoreOnly`),
  not one already queued (it keeps its place: `added: false`), any library game in the catalogue otherwise.
- **Advancing** (`queueAdvance(customerId)`): unless `paused`, `stalled`, the plan's borrowing is paused
  (`checkPlanOpen`) or there's no plan: while their plan has room (its games − their holds − their games at home > 0;
  games staff lent outside a plan never count, as since 16 Oct 2026's library lending, `planLoans`),
  the first `queued` game, by position, that has a copy free right now (2.5) and isn't already held by them or at home
  with them, is **held for them** (a normal library hold, `created_by: 'queue'`, the usual staff and member emails with
  queue words), and its queue row is `held` with the hold's id. Games with no free copy are passed over and keep their
  place. It runs after: a game of theirs is checked back in; one of their holds is cancelled, released or ends; they
  add to, reorder, unpause or restart their queue; their plan changes; and every maintenance run (all members with a
  queue). Never twice for one free slot: everything is read and written with no awaits between.
- **In store**: the hold lasts as any hold does (midnight on the third day). Collected → the queue row is `done`.
  **Not collected** (it expires) → the queue row goes back to `queued` at its place and the queue **stalls**
  (`stalled: 1`, reason `missed`): nothing more is held until they act ("Start my queue again", or any change to their
  queue, a reserve or a borrow). Mo's rule: holds don't stack up while someone's away.
- **By post** (`delivery: 'post'`): the hold lasts until the **next Wednesday 10pm (Lair time) at least 24 hours
  away**, and a postal send is made for it (5.3). Not confirmed and paid by then → the hold ends (back on the shelf),
  the send `lapsed`, the queue row back to `queued`, and the queue stalls (reason `lapsed`).
- A cancelled hold that came from the queue puts its row back to `queued` (a member cancelling it doesn't stall).

Routes (logged in; 401 `login` for guests):
- `GET /me/queue` → `{ queue: [item], settings: { paused, delivery, area, stalled, stalledReason }, sends: [send],
  watching: [watch], plan: { name, games, holds, atHome } | null, postage: { auckland: 1000, … } }` (`atHome`: their
  games at home that use up the plan, so not lent ones). `item` = `{
  productId, variantId, title, handle, image, shelfCode, position, status, holdId, hold: { until } | null, available }`
  (`available`: a copy is free right now). Items `queued` and `held` only, by position.
- `POST /me/queue { productId }` → `{ ok, added, ...GET /me/queue }`. 403 `member` (no plan), 409 `full` (30),
  422 `inStoreOnly`, 422 `product`.
- `POST /me/queue/remove { productId }` → `{ ok, removed, ... }` (a `held` one keeps its hold; it just leaves the queue).
- `POST /me/queue/move { productId, to }` (`to`: 1-based position) → `{ ok, ... }`.
- `POST /me/queue/settings { paused?, delivery?, area? }` → `{ ok, ... }` (unpausing, or changing delivery, clears
  `stalled` and advances).
- `POST /me/queue/restart` → clears `stalled` and advances → `{ ok, ... }`.

### 5.2 A game on a table booking (booking holds)

- `POST /bookings` (`kind: 'table'`) takes an optional `game: { productId }`: an active library game of kind `game` in
  the catalogue (422 `game` otherwise). It's saved on the booking (`bookings.game_product_id`, `game_title`,
  `game_handle`, `game_image`, `game_state`, `game_hold_id`), and the answer's booking carries `game: { productId,
  title, handle, image, state, holdFrom, holdId }`.
- `POST /bookings/:id/game { productId | null }` (the booking's owner, or staff with `tables`): attach, change or
  take off the game until the booking starts (409 `started`). Changing or removing it releases its hold. A guest
  booking (no account) can only get a game when it's made.
- **The hold**: from **midnight (Lair time) at the start of the day 3 days before the booking's day** (a Saturday
  booking: from Wednesday 00:00) until the booking ends. Maintenance (and attaching inside the window) makes a library
  hold with `kind: 'booking'`, `booking_id`, the booking's `customer_id` (or ''), `until` = the booking's end. Booking
  holds **never count** against anyone's plan, never show in a member's holds (`GET /me` holds), and never expire
  before the booking ends; they count as holds for copies (so the quiz and reserve see the copy as taken).
- `game_state`: `waiting` (before the window), `held`, `unavailable` (no copy free when the window opened: the
  booker is emailed once to pick another, and staff see it on the booking), `played` (the booking was checked in),
  `released` (the booking was cancelled, moved out of the window or the game changed). A cancelled or no-show booking
  releases its hold; moving the booking moves the window.
- Big-box games (`table: 'double'`) are allowed on any booking; the answer's `game.double` says so for the theme to
  flag.
- Staff see booking holds in `GET /library/holds` with `kind: 'booking'` and `booking: { id, code, start, name }`.

### 5.3 Postal sends (`library_sends`)

`id`, `customer_id`, `hold_id`, `queue_id`, `product_id`, `title`, `shelf_code`, `area`, `postage` (cents),
`status` (`waiting`, `checkout`, `paid`, `packed`, `sent`, `lapsed`, `cancelled`), `confirm_by` (ms), `send_day`
(`YYYY-MM-DD`, the Thursday), `draft_order_id`, `checkout_url`, `order_id`, `order_name`, `created_at`,
`updated_at`.

- **Postage** comes from config `LIBRARY_POSTAGE` (JSON, cents by area), default the website's rates on the shipping
  block: `{"auckland":1000,"auckland-rural":1500,"nationwide":2000,"nationwide-rural":3000}`. Mo can change it in the
  config table.
- `POST /me/queue/sends/:id/confirm { area }` → makes a Shopify checkout for that customer (a draft order with
  `purchasingEntity` the customer, so store credit and saved cards work at checkout; one $0 line "Library swap:
  <title> (<shelf code>)" that **requires shipping**, so checkout takes their address; a shipping line "Postage
  (<area words>)" at the area's price; tag `lair-library-post`; attribute `_libsend` = the send's id) → `{ send,
  checkoutUrl }`. The send is `checkout`. Confirming again reuses the checkout while it's open. 409 `lapsed` after the
  cutoff; 503 `shopify` when the checkout can't be made.
- `POST /me/queue/sends/:id/skip` → "Not this time": the hold ends now, the game goes back in their queue at its
  place, the send is `cancelled`, and the queue stalls (reason `skipped`).
- **Paid**: the `orders/paid` webhook sees `_libsend` (on the order or a line), checks the order came from that send's
  own draft order (as bills are), and marks it `paid` with the order's id and name. A payment for a send that lapsed
  meanwhile is flagged to `STAFF_EMAIL` ("posted after the cutoff: send it next Thursday or refund").
- **The cutoff**: maintenance lapses `waiting` and `checkout` sends past `confirm_by` (a `checkout` one gets 30
  minutes' grace for a payment in flight).
- **Staff**: `GET /library/sends?status=open|all` (perm `library`) → `{ sends }` (open: waiting, checkout, paid,
  packed; by `send_day`, then name), each with the member's name, email and code; `POST /library/sends/:id/update {
  status: 'packed' | 'sent' | 'cancelled', note? }`. **Sent** collects the hold: the game is at home with them (a loan,
  `out_by: staff`), the queue row `done`. Cancelled ends the hold (back on the shelf) and puts the game back in their
  queue.

### 5.4 Tell me when it's back (`library_watch`)

`customer_id` + `product_id` (PK), `variant_id`, `title`, `handle`, `created_at`, `told_at`.

- `POST /library/watch { productId }` (logged in) → `{ ok, watching: true }`; `POST /library/watch/remove {
  productId }` → `{ ok, watching: false }`. 401 `login`, 422 `product`. At most 50 a member.
- When a watched game has a copy free (a check-in, a hold ending, a send cancelled, or maintenance noticing), each
  watcher gets one email ("<title> is back on the shelf") and the watch is deleted. A member who has it at home or on
  hold isn't told.

---

## 6. Staff routes

- `GET /pick/games?filter=check|low|auto|basic|staff-picks|all&q=&offset=&limit=` (perm `library`) → `{ games: [{
  productId, title, handle, image, shelfCode, facts, source, checked, checkedBy, checkedAt, staffPick, status }],
  total }`. `check`: not checked yet, low confidence first, then auto, basic, seed; `q` matches title or shelf code.
  `limit` ≤ 100.
- `POST /pick/games/:productId { facts?, checked?, staffPick? }` (perm `library`) → `{ game }`. 422 `facts: <field>`.
- `POST /pick/sync` (perm `library`) → `{ synced, added, gone, tagged }`.
- `GET /pick/report?days=7|30|90` (perm `library` or `community`) → `{ from, to, sessions, byDoor, byMode,
  finished (sessions with picks), actions: { [action]: n }, asks: [{ players, time, brain, team, vibes, count,
  fitCount (median), gap }] (top 20 by count), gaps: [the asks with median fitCount under 5, worst first, up to 10],
  picked: [{ productId, title, shown, acted }] (top 20 shown), acted: [top 20 by actions], neverPicked: number,
  ratings: { up: [{ productId, title, ups, downs }], down: […] }, relaxed: { time, filters, availability, players } }`.
- `GET /library/sends`, `POST /library/sends/:id/update`: 5.3. `GET /library/holds` gains booking holds (5.2).

Staff can switch a game's **staff pick** on the check page (`staffPick: true`).

---

## 7. Maintenance (every 10 minutes, each step on its own, never throwing)

1. `syncCatalog` (1.1), then basic facts for new games and up to 5 auto-tags (1.2).
2. Booking holds: make those whose window opened, release those whose booking ended, was cancelled or moved, mark
   `unavailable` and email once.
3. Postal sends past their cutoff lapse (5.3).
4. Queues advance for every member with a `queued` row (5.1), at most 200 members a run.
5. Watches: tell watchers of games with a free copy (5.4), at most 100 emails a run.
6. Old pick sessions deleted (3.10), 500 a run.

---

## 8. Emails (Gobgob voice; money and rules plain first)

- **Queue hold, in store** (member): subject "<title> is next in your queue and on hold for you"; "Kia ora <first>!
  <title> came up next in your queue, so it's on hold for you until <when>. Collect it at the counter with your member
  code." Button: See your queue (My Lair › Library).
- **Queue hold, by post** (member): subject "Your next game is ready to post: <title>"; "<title> came up next in your
  queue. Confirm and pay the postage (<price>) by <Wednesday 10pm> and it goes out on Thursday. Not this time? Skip it
  and it stays in your queue." Button: Send it (My Lair › Library).
- **Queue paused** (member, on a missed or lapsed one): "<title> wasn't collected, so it's back on the shelf and your
  queue is paused. Start it again in My Lair whenever you're ready." (lapsed: "wasn't confirmed by the cutoff")
- **Booking game unavailable** (booker): subject "Pick another game for <day>"; "Every copy of <title> is out right
  now, so we can't hold it for your table on <day>. Pick another game in My Lair, or grab something off the shelves on
  the night."
- **Back on the shelf** (watcher): subject "<title> is back on the shelf"; "Good news, friend: <title> is back. Reserve
  it before someone else does." Button: Reserve it.
- **Your picks** (3.9): subject "Your game picks from Dice Goblin"; each pick with its picture, players, time and
  reason line; "See them again" (the shared link); "Book a table" and "Join the library" links.
- **Staff**: "Post this Thursday: <title> for <name>" when a send is paid; the late-payment flag (5.3).

Words in every route answer are in `PICK_MESSAGES` (`src/pick.js`) and `QUEUE_MESSAGES` (`src/queue.js`), word for
word as below.

| Key | Words |
| --- | --- |
| `login` (pick) | Log in to save your picks. |
| `loginRate` | Log in to rate games. |
| `loginQueue` | Log in to see your queue. |
| `member` | Join the library to start a queue. |
| `full` (queue) | Your queue is full (30 games). Take one off to add another. |
| `inStoreOnly` | That one's rare, so it stays in the Lair. Book a table and play it here instead. |
| `product` | That isn't one of our library games. Refresh the page and try again. |
| `gone` | Those picks have gone. Take the quiz again for fresh ones. |
| `notYours` | Those picks aren't yours to change. Take the quiz again to make your own. |
| `email` | That email address doesn't look right. Check it and try again. |
| `busy` | Gobgob needs a breather. Try again in a few minutes. |
| `game` | Pick a game from the library to bring to your table. |
| `started` | That booking has started, so its game can't change now. |
| `lapsed` | The cutoff for this Thursday has passed, so it's back on the shelf. It's still in your queue. |
| `shopify` | We couldn't open the checkout just now. Try again in a minute, or call us. |
| `facts` | That game's details don't look right: <field>. |
| `watchFull` | You're watching 50 games already. Stop watching one to add another. |

---

## 9. The theme (branch `r17-theme`)

Mobile first (most people tap through this on a phone at a table), keyboard and screen reader friendly (tap targets
≥ 44px, focus kept in the dialog, results announced, `prefers-reduced-motion` honoured), fast (no new libraries; the
quiz doesn't load lair-core.js). All words from `locales/en.default.json` (`help_me_pick.*`) or section settings, so
Mo can change them; Gobgob's voice only on the results (load the gobgob-voice skill for those lines). NZ spelling.

### 9.1 The quiz (`r17-quiz`)

- `snippets/help-me-pick.liquid` renders `<help-me-pick>` once per page (a `<dialog>`, the words as JSON, and the
  script and stylesheet, deferred). Any element with `data-help-me-pick` opens it (`data-door`, `data-mode`). It also
  opens on `document.dispatchEvent(new CustomEvent('help-me-pick:open', { detail: { door, mode, players, date,
  bookingId, tables } }))` (the booking page sends this).
- `sections/help-me-pick-page.liquid` + `templates/page.help-me-pick.json`: the page `/pages/help-me-pick` (the section
  isn't called help-me-pick: no section shares the snippet's name, as tools that look in sections too would loop). It shows the quiz
  in the page (not a dialog) and reads `?door=table&table=T14` (table QR: play here, that table known), `?kiosk=1`
  (kiosk mode), `?p=<sessionId>` (shared picks, read only, with "Take the quiz yourself").
- `sections/help-me-pick-banner.liquid`: a callout ("Not sure what to play? Help me pick", with settings) added to
  `templates/page.board-game-rental.json` (after the intro), `templates/product.membership.json` and
  `templates/collection.board-game-rental.json` (above the games). The booking page (`sections/lair-play.liquid`)
  renders the snippet so the booking confirmation can open it.
- **Steps**: (1) Play here or borrow? (skipped when the door knows; a "Curious about roleplaying?" link here starts
  the roleplaying branch) (2) How many players? 1–8+, with a "Kids playing?" switch that asks the youngest's age
  (prefilled from a booking) (3) How long have you got? (4) How much brain power? (5) Team up or beat each other? (6)
  What's the vibe? (any; "Any vibe" is fine) (7) the swipe round: about eight boxes from `POST /pick/swipes`, one at a
  time, Like / Nope / Don't know (buttons and swipe; "Just show me" skips; a member with `taste.has` gets "Use what
  you liked last time" to skip it) (8) the picks. Back works on every step. A progress bar. Each answer is one tap.
- **The picks**: the player type card on top (plain name and line, made to screenshot; Share it), then the three
  picks and the wildcard (marked "Wildcard"), each a card: box picture, name, Gobgob's one reason line (composed from
  `why` with the locale templates), players and best at, time, brain power in words, co-op or competitive, age, the
  how-to-play video (or a YouTube search), where it stands (on the shelf / reserved, back by … / out with a member),
  where it's shelved in words ("DGL34-M011: 3–4 players, middle shelves, 11th from the left"; S top shelf, M middle
  shelves, L bottom; RPG books just the code), "Needs a double table" in play mode when it does, add-ons, the missing
  pieces note, and actions (9.3). Under the picks: **Fine-tune** (theme chips, games you already love with search
  `GET /pick/known`, light on reading, colour-blind friendly, easy-to-handle pieces, hide games I've had for members;
  picks update after each change, debounced), **Show me different picks** (`again: true`), **Start again**.
- `relaxed` shows one plain line ("Nothing fit exactly, so we stretched the time."). No picks at all: "Nothing in the
  library fits all of that. Try fewer players or a different time." with Start again.
- **Kiosk mode**: big type, no login actions (each pick's actions become "Scan to take these picks with you": a QR
  of the shared link, made with `assets/qr.js`), starts fresh after 60 seconds without a touch (a 10-second "Still
  there?" first), keeps nothing in storage.
- **Table QR**: play mode, the table known: "Needs a double table" shows only when that table is a single one (the
  quiz has no floor plan; it shows it for every single table, so for now always in table mode).
- The quiz talks to the Lair itself (`/apps/liar` or the theme setting), like `lair-wishlist.js`, in both live and
  demo mode (picks need the real library). The session id and edit key live in `sessionStorage` so a refresh keeps
  the picks.

### 9.2 Gobgob's reason lines and the player types (`locales`)

- Reason lines: one sentence per pick from its strongest reason, a second clause from the next (e.g. best-at 4 +
  time: "Best at four, and it's done in about an hour."; vibe laughs: "Loud, silly and over before anyone sulks.").
  Write at least two variants per code and pick by a hash of the game id so cards don't repeat each other. Gobgob
  (they/them) may appear in a few, never in all. No hype, no em dashes.
- Player types (plain, Mo): Party player "You like big groups, quick rules and lots of laughs." Thinker "You like
  planning ahead and solving puzzles." Team player "You like working together to beat the game." Competitor "You like
  going head to head to win." Adventurer "You like strong themes and a story to tell." Chill player "You like calm,
  easy-going games."

### 9.3 A pick's actions

- **Reserve to borrow** (borrow mode, a copy free): members `POST /library/holds` (the card's variantId, productId,
  title, shelfCode, handle, image); not logged in → log in and come back; logged in without a plan → "Join the
  library" (the plans). Play mode shows it under "More".
- **Add to my queue** (members, not in-store-only) → `POST /me/queue`. Not a member → "Join the library to start a
  queue". The answer's item for the game says what happened: `held` (a copy was free and the plan had room) shows the
  card as theirs ("…was next in your queue, so we're holding it for you", by post "…Confirm and pay the postage in My
  Library by [when]"); `queued` says its place among the games still waiting, and the button becomes **In your queue**
  (to My Library), also for games already waiting in their queue (GET /me/queue, once a visit).
- **Tell me when it's back** (no copy free) → `POST /library/watch` (log in first).
- **Book a table to play it** (play and borrow) → the booking page with `?game=<productId>&pick=<sessionId>`. In the
  booking door: **Add to my booking** → `POST /bookings/:bookingId/game { productId }`.
- **Find it on the shelf** opens the shelf words. **Buy your own copy** (shopCopy) links `/products/<handle>`.
- **Save to My Lair** (`POST /pick/:id/save`, log in first), **Share** (Web Share API, else copy the link
  `/pages/help-me-pick?p=<id>`), **Email me my picks** (`POST /pick/:id/email`; the unticked newsletter box also posts
  Shopify's customer form: `form_type=customer`, `contact[email]`, `contact[tags]=newsletter,help-me-pick`).
- Every action also sends `POST /pick/:id/event` (fire and forget).
- Roleplaying picks: "Book a TTRPG session" (the GM games page) first when `gm: lair`, then the book's own page.

### 9.4 Members, game pages and bookings (`r17-member`)

- `assets/lair-core.js` LiveBackend (and `lair-demo.js` fakes, kept in the demo state): `myQueue()`,
  `addToQueue(productId)`, `removeFromQueue(productId)`, `moveInQueue(productId, to)`, `queueSettings(patch)`,
  `restartQueue()`, `confirmSend(id, area)`, `skipSend(id)`, `watchGame(productId)`, `unwatchGame(productId)`,
  `rateGame(productId, rating, source)`, `myPicks()`, `bookingGame(bookingId, productId)`, `pickGame(productId)`.
- **My Library** (`assets/lair-my-library.js`, words in `sections/my-lair.liquid`): "Your queue" (the list with
  pictures, Up / Down, Remove, which one's held and until when, "Pause my queue" switch, "How do you swap?" In the
  Lair / By post, and by post the area), the stalled notice with "Start my queue again", "Ready to post" cards (the
  game, the postage, "Send it" opens the checkout, "Not this time"), "Rate your last games" (thumbs up/down on
  `toRate`), "Games you're watching" (stop), "Your saved picks" (each opens `/pages/help-me-pick?p=<id>`), and a
  Help me pick button. Empty queue: a line about how the queue works, and the Help me pick button.
- **A game's page** (library copy: `sections/main-product.liquid`, `snippets/library-reserve.liquid`,
  `assets/lair-library.js`): "Add to my queue" for members (not in-store-only), "Tell me when it's back" when no copy
  is free, and "Played it?" thumbs up/down for anyone logged in.
- **Booking** (`assets/lair-booking.js`): `?game=<productId>` shows the game on the booking ("Bringing: Catan", its
  picture, "We'll hold it for you from <Wednesday>", "Needs a double table" when it does, Remove) from `GET
  /pick/game/:id`, and sends `game: { productId }`; the confirmation shows the game and the hold words, or "Pick a
  game for your table", which opens the quiz (booking door, players and date) via `help-me-pick:open`. My Lair's
  booking card shows the attached game.

### 9.5 Staff (`r17-staff`)

- A new tab **Help me pick** (perm `library`) in `assets/lair-staff.js`'s `TABS`, built in
  `assets/lair-staff-picks.js` (+ css): **Check games** (`GET /pick/games?filter=check`: one game at a time with its
  picture, every fact as chips and number fields, "Looks right" (`checked: true`), Save, Skip, Staff pick switch,
  filters and search, "Sync with Shopify now"), **Report** (`GET /pick/report`, 7/30/90 days: sessions, finished,
  actions, top asks and the gaps worth buying for, most picked and acted on, ratings, how often it had to stretch),
  **Table QR codes** (one QR per table from the store's rooms, linking `/pages/help-me-pick?door=table&table=<code>`,
  printable: on A4 and on the 150 × 100 mm sticker printer).
- The **Library** tab: booking holds in the holds list ("For a table: <name>, <day>"), and **Postal swaps**
  (`GET /library/sends`): this Thursday's list (paid ones to pack first), Packed, Sent, Cancel.

---

## 10. Checking

- Backend: `npm test` passes, with `test/round17-pick.test.js` and `test/round17-queue.test.js` covering the rules
  above (matching, relaxing, wildcard determinism, sessions and edit keys, rate limits, seed and staff edits never
  overwritten, sync parsing, basic facts, auto-tag validation; queue advance never doubling a slot, stall rules,
  postal cutoff and lapse, webhook payment verification, booking hold window across daylight saving (4 April 2027 and
  27 September 2026 changes), booking holds not counting against plans, watches told once).
- Theme: Theme Check clean for new files; the quiz used start to finish at 375px wide in a real browser against a
  local Lair, in both light and dark colour schemes if the theme has them.

# Dice Goblin Lair: notes for Claude

This repo is the Lair, the Cloudflare Worker behind Dice Goblin's website (dicegoblin.nz) and counter: table bookings, the GM games board, events, members and their loyalty card, session passes, store credit, the board game library and its memberships, the till, Games Workshop orders and Stock off. Mo owns Dice Goblin, a tabletop hobby shop and events space in Auckland. The theme the customers see is a separate repo, `dicegoblinnz/dice-goblin-website`: the live site is its branch `r17-theme` (a push there reaches customers at once), and `dice-goblin-2-theme` is an unpublished preview, not the live site.

`README.md` is the full manual (about 150 KB): how it fits together, every config key, the rules the app enforces, and every route under "For developers". Grep it for what you need. Never read it whole.

## Where things are

- `src/`: one file per feature (`till-sales.js`, `gm-perk.js`, `order-rolls.js`, `stock-off.js`, …). `src/index.js` routes requests and checks Shopify's app proxy signature. `src/lair.js` is the Durable Object with its SQLite tables.
- `docs/contracts/lair-api-contract-v<round>-<name>.md`: the agreed spec for each round. Read the round's contract before you change its feature, and keep it in step with the change.
- `test/`: node:test checks, `round<N>-<name>.test.js` for each round.
- `tools/qa/`: local-only checks that never ship. `live/` runs the real Worker against a fake Shopify, and `theme-mock/` renders the theme without Shopify. `tools/qa/README.md` says how.
- `pos-app/`: the Shopify POS tile, deployed by GitHub Actions on a push to `main` that touches `pos-app/`.

## The rules

- **`main` is live.** Cloudflare Workers Builds deploys every push to `main`. Its builds of other branches fail, and a commit pushed to a branch first isn't built again when `main` reaches it, so `main` needs a commit of its own to deploy (a merge commit, or an empty one). Work on a branch, and push to `main` only when the change is meant to go live.
- **This repo is public.** Never put a key, token, secret or anyone's email address in code, `wrangler.toml` or a contract. Keys and settings live in the D1 `config` table or Worker secrets (README, "Where things live").
- **Cloudflare's SQLite limits:** at most 100 bound values a query and 5 terms in one compound SELECT. Node's SQLite allows more, so every test file checks both through `test/cloudflare-sql.js`.
- **A change to a rule** (bookings, money, credit, loyalty) gets a failing test first, then the change (the `test-first` skill), and goes through the `code-review` skill before it goes live.
- **Words people read** (emails, the website's messages, the counter) are in Gobgob's voice: use the `gobgob-voice` skill. NZ spelling everywhere.

## Commands

```sh
npm test                                   # every check (Node 22+, uses node:sqlite)
node --test test/round37-changes.test.js   # one file
npx wrangler dev                           # run it locally; secrets go in .dev.vars
```

## Helpers on Haiku

You lead on Opus: you plan, decide, write and check. Legwork goes to the helpers in `.claude/agents/`, which run on Haiku at about a fortieth of Opus's price while a job stays under 100,000 tokens (about an eighth past that), so brief them tight.

- `lair-scout`: where something lives, which files touch it, what a route answers, which contract covers it. Read-only, answers with `file:line`.
- `lair-tests`: runs the checks you name and reports failures with the shortest output that shows why.
- `lair-mechanic`: a mechanical change you've fully specified (a rename, the same edit in many files, a list of values), then the check you give it.

What stays with you, always: anything a customer or staff member reads, design, rules and money logic, deciding what a failure means, and the final review. Treat a helper's report as a lead, not a fact: open the lines it points to before you build on them. Brief each one with the exact question, where to start looking and what to report, and send independent ones at once. One that comes back unsure, or that would need a judgement call, is yours to finish, not to send again.

## Keeping usage low

Every chat comes out of Mo's usage, so get the most done for the least.
- One round or piece of work per chat. Finish by giving Mo the prompt for the next chat, since every step in a long chat costs more than the same step in a fresh one.
- Grep, then read only the lines you need. Don't re-read what you've just edited.
- While you work, run only the test files that cover your change. Run the full `npm test` once before you finish.
- Don't narrate between steps, and ask Mo only about the decisions that are his.

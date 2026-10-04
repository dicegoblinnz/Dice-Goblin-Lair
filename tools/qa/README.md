# QA tools (local only)

Nothing here ships. The Worker bundles only `src/`, and `npm test` runs only `test/*.test.js`.

## live: the real Worker with a fake Shopify

`DG_THEME=/path/to/theme sh tools/qa/live/run-all.sh` runs the whole thing from a clean slate, against that theme checkout. It needs `npm install` at the repo root first (for wrangler) and in `theme-mock` (for liquidjs). It takes about ten minutes, and the bookings it makes "today" need it to start before about 4pm Auckland time.

**What starts:**
- `fake-admin.mjs` on :8799 stands in for the Admin API, OAuth and Resend. It records every call in `fake-admin.calls.jsonl`.
- `wrangler dev` runs on :8787 with `dev/wrangler.toml`. Its entry, `dev/worker-entry.mjs`, sends every Shopify or Resend request to the fake and refuses anything else.
- Fake secrets come from `dev/dev.vars.example`, which `up.sh` copies to `dev/.dev.vars`. They include client secret `hush` and setup key `test-setup-key`.
- `down.sh` stops only what `up.sh` started (its saved pids and their children, and workerd from this checkout). `ONLY=wrangler` stops or starts just wrangler, so the fake keeps what it holds.
- Events come from `theme-mock/events-mock.mjs`: the store's events if `events-qa/events-data.json` is there, otherwise a stand-in set of weekly events, plus one-offs counted from today (tonight's D&D, and two Riftbound Sundays).

**What runs:**
- Seeds: `seed.mjs` and `seed-today.mjs`.
- POS routes: `pos-http.mjs`.
- Page flows, phone and desktop, driven by Playwright through `harness.mjs`.
- Round 5 (`flow-r5-*.mjs`): passes sold as a product (`LAIR-PASS-N` orders), birthday gifts, weekly regulars, the Members view, one bill at the POS (`/pos/checkin-member` with owed lines and the tab), and the staff page's owed rows with Waive, members list and gifts.
  - Weekly regulars need a session to have ended. `flow-r5-regulars-setup.mjs` books one, then `run-all.sh` stops wrangler and `r5-travel.py` moves that game a week earlier in the saved state, starts wrangler again, and `flow-r5-regulars.mjs` runs maintenance (`/setup`) and checks what's owed.
- `live-smoke.mjs`.

**Paths and config:**
- `harness.mjs` and `fake-admin.mjs` render the theme from `DG_THEME`. Point it at a theme checkout.
- Playwright is required from `/opt/node-tools/node_modules/playwright`, which comes with the Claude cloud container. Change that path anywhere else.
- `dev/wrangler.toml` is named `dice-goblin-lair-qa`. Never deploy with it.

## theme-mock: render the theme without Shopify

`npm install` (liquidjs), then `DG_THEME=/path/to/theme node -e "import('./render.mjs').then(m=>m.serve(4173))"` (or `node render.mjs check` to render every route once).

The other scripts are screenshot and flow checks built on it.

**Gotcha:** inside `{% liquid %}`, a comment line that starts with punctuation or holds quotes or brackets breaks liquidjs. Real Shopify is fine with it, so rephrase the comment.

## round5: theme checks for the round 5 branches

These run the theme in demo mode through `theme-mock`, at phone size and then desktop.
- `mg4/`: My Lair and the games board. `sh final.sh` runs them all.
- `bk4/`: the staff page. `r4/` holds the round 4 staff scripts.

Set `DG_THEME` to the branch checkout. The defaults point at the old worktrees.

Late at night, bookings seeded "today" can land on tomorrow and trip date checks. The bk4 scripts take `LAIR_AT=…` to pin the page clock.

## theme-check

`npm install`, then `node run.mjs /path/to/theme`. A clean theme prints `counts {}`.

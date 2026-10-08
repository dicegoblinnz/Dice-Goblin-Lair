#!/bin/sh
# The whole live QA run from a clean slate: fresh app state, a first-release GOB- booking, members and passes, today's
# bookings, the POS routes and webhooks, then every page flow (phone first, then desktop), the round 5 flows and the
# live smoke. Round 5: passes sold as a product, birthday gifts, weekly regulars (a week passes: wrangler stops,
# r5-travel.py moves their game a week earlier, wrangler starts again on the same state while the fake keeps running),
# the Members view, one bill at the POS, and the staff page's owed rows, members list and gifts.
# Round 6 (HTTP flows, flow-r6-*.mjs): the loyalty card (check-ins, stamps, rolls, store credit, staff rolls, customer
# since), spend by month and financial year (with the Shopify backfill), session gifts, library holds (one runs out of
# time: r6-travel.py moves it during the same restart) and guest seats (the GM's email, adoption on My Lair).
# DG_THEME is the theme checkout to render (the round 5 theme): DG_THEME=/path/to/theme sh tools/qa/live/run-all.sh
QA=$(cd "$(dirname "$0")" && pwd)
cd "$QA" || exit 1
if [ -z "$DG_THEME" ] || [ ! -f "$DG_THEME/config/settings_data.json" ]; then echo "Set DG_THEME to a theme checkout (config/settings_data.json not found in '$DG_THEME')"; exit 1; fi
export DG_THEME
LOG="$QA/run-all.log"
: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }
step() { say ""; say "===== $*"; node "$@" 2>&1 | tee -a "$LOG" | grep -E "^(PASS|FAIL)|passed|Error" ; }
./down.sh > /dev/null 2>&1
rm -rf "$QA/shots" && mkdir -p "$QA/shots"
./up.sh | tee -a "$LOG"
# the Durable Object's database exists after its first request; then add the old booking and restart on the same state
curl -s -o /dev/null "http://127.0.0.1:8787/setup?key=test-setup-key"
./down.sh > /dev/null 2>&1
python3 legacy.py | tee -a "$LOG"
KEEP=1 ./up.sh | tee -a "$LOG"
step seed.mjs
step seed-today.mjs
step pos-http.mjs
step flow-booking.mjs
for d in phone desktop; do
  step flow-events.mjs $d
  step flow-games.mjs $d
  step flow-mylair.mjs $d
  step flow-staff.mjs $d
  step flow-staff-games.mjs $d
  step flow-staff-camera.mjs $d
  step flow-mylair-refunds.mjs $d
done
step flow-r5-passes.mjs
step flow-r5-gifts.mjs
step flow-r5-regulars-setup.mjs
step flow-r6-holds.mjs
say ""
say "===== a week passes for the weekly regulars, and a library hold runs out of time (wrangler restarts on the same state)"
ONLY=wrangler ./down.sh > /dev/null 2>&1
python3 r5-travel.py | tee -a "$LOG"
python3 r6-travel.py | tee -a "$LOG"
KEEP=1 ONLY=wrangler ./up.sh | tee -a "$LOG"
step flow-r5-regulars.mjs
step flow-r6-holds-expiry.mjs
step flow-r5-members.mjs
step flow-r5-checkin-member.mjs
for d in phone desktop; do
  step flow-r5-staff.mjs $d
done
step flow-r6-loyalty.mjs
step flow-r6-spend.mjs
step flow-r6-gifts.mjs
step flow-r7-a.mjs
step flow-r6-guests.mjs
step flow-r7-b.mjs
step flow-r8-guests.mjs
step live-smoke.mjs
say ""
say "===== totals"
awk '/^===== /{step=substr($0,7)} /^[0-9]+\/[0-9]+ passed/{print $0 "  " step}' "$LOG" | tee -a "$LOG.totals"
grep -c "^FAIL" "$LOG" | sed 's/^/FAIL lines: /' | tee -a "$LOG"

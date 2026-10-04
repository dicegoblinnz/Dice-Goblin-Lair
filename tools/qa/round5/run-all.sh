#!/bin/sh
# Every round 5 theme check (My Lair and games board: mg4; staff page: bk4 and its round 4 scripts), phone then desktop.
# Usage: DG_THEME=/path/to/theme QA_PORT=4311 sh tools/qa/round5/run-all.sh
# LAIR_AT pins the staff page clock (default: 5pm today in Auckland), so late-night runs still book "today".
# Needs: npm install in tools/qa/theme-mock, Playwright at /opt/node-tools/node_modules/playwright,
# and python3 with zxing-cpp + pillow for the QR checks (pip install zxing-cpp pillow).
: "${DG_THEME:?Set DG_THEME to the theme checkout}"
export DG_THEME
export QA_PORT="${QA_PORT:-4311}"
export LAIR_AT="${LAIR_AT:-$(TZ=Pacific/Auckland date +%Y-%m-%d)T17:00}"
HERE="$(cd "$(dirname "$0")" && pwd)"
filter() { grep -v DEP0040 | grep -v trace-deprecation; }
echo "##### mg4 (My Lair, games board)"
sh "$HERE/mg4/final.sh" 2>&1 | filter
cd "$HERE/bk4"
echo "##### bk4 (staff page)"
# core takes a page query, not a size, so it runs with none
echo "=== core"; timeout 500 node core.mjs 2>&1 | filter | tail -6
for s in clockcheck giftshape; do echo "=== $s"; timeout 500 node $s.mjs 2>&1 | filter | tail -6; done
for t in phone desktop; do
  for s in counter members photo live-members gmlook; do
    echo "=== $s $t"; timeout 500 node $s.mjs $t 2>&1 | filter | tail -6
  done
done
for t in phone desktop; do echo "=== look $t"; timeout 300 node look.mjs $t r5 2>&1 | filter | tail -4; done
FORCED_AT="$(TZ=Pacific/Auckland date +%Y-%m-%d)T23:30"
echo "=== forced"; LAIR_AT="$FORCED_AT" timeout 300 node forced.mjs 2>&1 | filter | tail -4
for s in r4/staff r4/staff2 r4/split r4/live-shape; do echo "=== $s"; timeout 500 node $s.mjs 2>&1 | filter | tail -6; done
echo "##### done"

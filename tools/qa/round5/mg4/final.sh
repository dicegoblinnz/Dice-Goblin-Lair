#!/bin/sh
# The whole round-5 QA for My Lair and the games board: each script runs the phone (390x844) first, then 1280x800
cd "$(dirname "$0")"
for s in quotes bill series gifts games board-views; do
  echo "=== $s"
  timeout 500 node $s.mjs final-$s 2>&1 | grep -v DEP0040 | grep -v trace-deprecation | tail -4
done
echo "=== full pages"
timeout 300 node base.mjs final 2>&1 | tail -2

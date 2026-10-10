#!/bin/sh
# LOCAL QA ONLY (round 14): boot the real Worker as it's deployed (src/index.js with the repo's wrangler.toml) under
# workerd, and check it answers /health. workerd won't start a Worker whose main module exports anything but handlers and
# classes (a plain `export const` there stops it starting, so Cloudflare would refuse the deploy), and neither the tests,
# `wrangler deploy --dry-run` nor the QA dev entry (which re-exports only Lair and the handlers) start the real module.
# Run it before pushing a change to src/index.js. Nothing leaves the machine: local state in a throwaway folder, no secrets.
#   tools/qa/boot.sh        (PORT=8790 by default)
QA=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$QA/../.." && pwd)
WRANGLER=${WRANGLER:-$REPO/node_modules/.bin/wrangler}
PORT=${PORT:-8790}
STATE=$(mktemp -d)
cd "$REPO" || exit 1
"$WRANGLER" dev --local --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE" > "$STATE/wrangler.log" 2>&1 &
PID=$!
tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do tree "$child"; done
  echo "$1"
}
stop() {
  kill $(tree "$PID") 2>/dev/null
  wait "$PID" 2>/dev/null
}
for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
    echo "the Worker started and answers /health (after ${i}s)"
    stop
    rm -rf "$STATE"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  if grep -q "Incorrect type for map entry\|Uncaught\|failed to start" "$STATE/wrangler.log"; then break; fi
  sleep 1
done
echo "the Worker did not start:"
if grep -q "Incorrect type for map entry\|Uncaught\|SyntaxError\|TypeError" "$STATE/wrangler.log"; then
  grep "Incorrect type for map entry\|Uncaught\|SyntaxError\|TypeError" "$STATE/wrangler.log" | head -10
else
  grep -v "^\s*$" "$STATE/wrangler.log" | tail -25
fi
stop
rm -rf "$STATE"
exit 1

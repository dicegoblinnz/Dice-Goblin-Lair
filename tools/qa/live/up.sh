#!/bin/sh
# Start the fake Admin API (:8799) and the real Lair app under wrangler dev (:8787), fresh state unless KEEP=1.
QA=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$QA/../../.." && pwd)
WRANGLER=${WRANGLER:-$REPO/node_modules/.bin/wrangler}
cd "$REPO" || exit 1
# wrangler reads .dev.vars next to the config; the example holds fake values only (git ignores .dev.vars)
[ -f "$QA/dev/.dev.vars" ] || cp "$QA/dev/dev.vars.example" "$QA/dev/.dev.vars"
if [ "$KEEP" != "1" ]; then rm -rf "$QA/state"; rm -f "$QA/fake-admin.calls.jsonl"; fi
mkdir -p "$QA/state"
nohup node "$QA/fake-admin.mjs" > "$QA/fake-admin.log" 2>&1 &
echo $! > "$QA/fake-admin.pid"
# The config database's two tables, so the app's config read and health notes don't log errors
"$WRANGLER" d1 execute dice-goblin-lair-config --local -c "$QA/dev/wrangler.toml" --persist-to "$QA/state" \
  --command "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS status (key TEXT PRIMARY KEY, value TEXT, at TEXT);" > "$QA/d1.log" 2>&1
nohup "$WRANGLER" dev --local --port 8787 --ip 127.0.0.1 -c "$QA/dev/wrangler.toml" --persist-to "$QA/state" > "$QA/wrangler.log" 2>&1 &
echo $! > "$QA/wrangler.pid"
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:8787/health | grep -q ok; then echo "up after ${i}s"; exit 0; fi
  sleep 1
done
echo "wrangler did not come up"; tail -30 "$QA/wrangler.log"; exit 1

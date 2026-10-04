#!/bin/sh
# Stop what up.sh started: wrangler (with its workerd and esbuild children) and the fake Admin API.
# ONLY=wrangler stops just wrangler, so the fake keeps what it holds (orders, drafts, credits, emails) across a restart.
# Only our own processes: the trees under the pids up.sh saved, and any workerd left over from this checkout's wrangler.
# Other people's wrangler or browsers on the same machine are never touched.
QA=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$QA/../../.." && pwd)
# every descendant of a pid, deepest first
tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do tree "$child"; done
  echo "$1"
}
NAMES="wrangler fake-admin"
[ "$ONLY" = "wrangler" ] && NAMES="wrangler"
for f in $NAMES; do
  if [ -f "$QA/$f.pid" ]; then
    pids=$(tree "$(cat "$QA/$f.pid")")
    kill $pids 2>/dev/null
    rm -f "$QA/$f.pid"
  fi
done
sleep 1
# A workerd that outlived its wrangler: only one started from this checkout's node_modules.
for p in $(pgrep -f "$REPO/node_modules/@cloudflare/workerd" 2>/dev/null); do kill "$p" 2>/dev/null; done
LEFT="$REPO/node_modules/.*(wrangler|workerd)"
[ "$ONLY" = "wrangler" ] || LEFT="$LEFT|$QA/fake-admin.mjs"
if pgrep -f "$LEFT" > /dev/null 2>&1; then sleep 1; fi
pgrep -af "$LEFT" || echo "all stopped"

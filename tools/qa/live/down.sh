#!/bin/sh
# Stop what up.sh started (wrangler, its workerd children, and the fake Admin API).
QA=$(cd "$(dirname "$0")" && pwd)
for f in wrangler fake-admin; do
  if [ -f "$QA/$f.pid" ]; then
    pid=$(cat "$QA/$f.pid")
    pkill -TERM -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
    rm -f "$QA/$f.pid"
  fi
done
sleep 1
# workerd started by this wrangler (its config lives under our state dir or the dev folder)
pgrep -f "workerd.*" >/dev/null && pgrep -af workerd | grep -v grep | awk '{print $1}' | while read p; do
  if tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q -e "tools/qa/live" -e "r4-live-qa" -e "wrangler"; then kill "$p" 2>/dev/null; fi
done
pgrep -af "wrangler dev|workerd|fake-admin" | grep -v pgrep || echo "all stopped"

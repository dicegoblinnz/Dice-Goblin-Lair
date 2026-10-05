# Round 6 (d), part 2: Hana's Azul hold runs out of time. Run with wrangler stopped (ONLY=wrangler ./down.sh), after
# flow-r6-holds.mjs: that hold's until moves to a minute ago, so the next maintenance run (/setup or the cron) expires
# it and emails her. Nothing else changes.
import json, glob, sqlite3, time

plan = json.load(open('r6-holds.json'))
f = glob.glob('state/v3/do/*-Lair/[0-9a-f]*.sqlite')[0]
db = sqlite3.connect(f)
past = int(time.time() * 1000) - 60 * 1000
db.execute("UPDATE library_holds SET until = ? WHERE id = ? AND status = 'held'", (past, plan['expiring']))
db.commit()
print('hold', plan['expiring'], 'now ends at', db.execute('SELECT until, status FROM library_holds WHERE id = ?', (plan['expiring'],)).fetchone())

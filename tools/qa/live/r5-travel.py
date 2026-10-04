# Round 5 (b): a week passes for the weekly regulars. Run with wrangler stopped (ONLY=wrangler ./down.sh), after
# flow-r5-regulars-setup.mjs: the weekly game's sessions (with their seats and the GM's table holds) and the one-off move
# a week earlier, as does the series' first day, so its first session and the one-off have ended (unpaid) and the
# second session is next. The app reads the change on its next start; maintenance then rolls the regulars forward.
# Nothing else moves, and the seats keep when they were booked (after owed-from), so the ended series seats are owed.
import json, glob, sqlite3

WEEK = 7 * 24 * 3600 * 1000
plan = json.load(open('r5-regulars.json'))
f = glob.glob('state/v3/do/*-Lair/[0-9a-f]*.sqlite')[0]
db = sqlite3.connect(f)
games = [r[0] for r in db.execute('SELECT id FROM games WHERE series_id = ? OR id = ?', (plan['seriesId'], plan['oneOffId']))]
marks = ','.join('?' * len(games))
db.execute(f'UPDATE bookings SET starts_at = starts_at - ?, ends_at = ends_at - ? WHERE game_id IN ({marks})', (WEEK, WEEK, *games))
db.execute(f'UPDATE games SET starts_at = starts_at - ?, ends_at = ends_at - ? WHERE id IN ({marks})', (WEEK, WEEK, *games))
db.execute("UPDATE series SET first_day = date(first_day, '-7 days') WHERE id = ?", (plan['seriesId'],))
db.commit()
first = db.execute('SELECT starts_at, ends_at FROM games WHERE id = ?', (plan['sessions'][0],)).fetchone()
print(f"moved {len(games)} sessions a week earlier; the first now ends at {first[1]}",
      db.execute('SELECT first_day FROM series WHERE id = ?', (plan['seriesId'],)).fetchone()[0])

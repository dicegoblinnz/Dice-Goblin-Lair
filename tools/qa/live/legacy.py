# A booking from the first live release (ref GOB-7K2QXM), as the round 4 migration leaves it: the booking row plus
# its key in the codes table. Run with wrangler stopped; the app reads it on its next start.
import sqlite3, glob, time, datetime, zoneinfo
f = glob.glob('state/v3/do/*-Lair/[0-9a-f]*.sqlite')[0]
db = sqlite3.connect(f)
tz = zoneinfo.ZoneInfo('Pacific/Auckland')
today = datetime.datetime.now(tz).date()
start = int(datetime.datetime(today.year, today.month, today.day, 19, 0, tzinfo=tz).timestamp() * 1000)
end = start + 2 * 3600 * 1000
now = int(time.time() * 1000) - 7 * 24 * 3600 * 1000
db.execute("""INSERT OR REPLACE INTO bookings (id, ref, kind, status, tables, room, starts_at, ends_at, people, name, email, phone, notes, activity, extras, pay, paid, amount,
  game_id, customer_id, hold_until, draft_order_id, order_id, created_at, updated_at, covered, paid_amount, split)
  VALUES ('bk_legacy0000000001', 'GOB-7K2QXM', 'table', 'confirmed', '["T16"]', 'main-room', ?, ?, 3, 'Old Release Rangi', 'old@example.com', '', '', 'board', '[]', 'day', 0, 3000,
  NULL, NULL, NULL, NULL, NULL, ?, ?, 0, 0, 0)""", (start, end, now, now))
db.execute("INSERT OR IGNORE INTO codes (key, code, kind, target_id, created_at) VALUES ('GOB7K2QXM', 'GOB-7K2QXM', 'booking', 'bk_legacy0000000001', ?)", (now,))
db.commit()
print('legacy booking GOB-7K2QXM today 7pm at T16:', db.execute("select ref, status, starts_at from bookings where ref='GOB-7K2QXM'").fetchall())

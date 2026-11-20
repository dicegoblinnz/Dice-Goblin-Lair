# Lair API contract v47: who's going on Meetup

Mo, 20 Nov 2026: "I want my blood on the clock tower to link to this website for people to join is there a way for us
to get numbers on my website from meetup?" Then: "The meetup group is not mine and I prefer the free option either way
make it, that it checks once every 8 hours no need to be every 15 mins."

Code: `src/meetup.js`. Checks: `test/round47-meetup.test.js`.

## What it does

1. An event's **Link** (`lair_event` `link`, set in the staff page's events editor) that is a Meetup event's address
   (`https://www.meetup.com/<group>/events/<id>/`, or Meetup's short `https://meetu.ps/e/...` link) is a Meetup link.
   No other address is ever fetched: a short link's hand-on is followed only to another Meetup link (3 hops at most).
2. The 10-minute run reads each Meetup link's public page **at most once every 8 hours**, 3 pages a run at most. It
   uses no Meetup account, key or API.
3. From the page's own data it keeps who's going (`goingCount`), the places there are (`maxTickets`, none when 0) and
   when it starts (`dateTime`), in `meetup_counts`. A cancelled event, or a page that doesn't say, counts as a read
   that failed.
4. A read that fails keeps the last numbers and waits its 8 hours like any other. Numbers older than 26 hours, or of
   an event that started more than 12 hours ago, aren't given out. A link no event has any more is forgotten.
   A Lair that couldn't read the events from Shopify reads nothing and forgets nothing.
5. `GET /floor` answers `meetup: { [link]: { going, cap, start } }` for everyone: counts only, never names.
6. Nothing here changes a sign-up, a place, a waitlist or a price: the event's own capacity and sign-ups are as they
   were. The website shows the Meetup number beside them (theme: `assets/lair-calendar.js`).

## What the website shows

On a date within 12 hours of the Meetup event's start: "10 going on Meetup" on its card, and in its sheet a **Join on
Meetup** button with "10 going on Meetup · 22 places left there". With no number to show (never read, or too old), the
button alone.

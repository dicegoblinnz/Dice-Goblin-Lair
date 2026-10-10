# Lair API contract v14-discord: the Discord bot

Round 14 (10 Oct 2026). Mo: "Can we build a discord mod or something and make it link to the website for dice goblin to
organize and fit people in, inside the discord? And update the website too?" He picked all four parts: TTRPG sessions,
events, table bookings, and auto-posts with seat pings.

The bot is another front door to the same Lair, like the POS tile. A seat taken in Discord is a seat taken on the website:
the same rules, codes, emails and seat counts, so nothing can be double booked. It's all HTTP (slash commands, buttons,
selects and modals sent to the Worker), with no gateway connection, so it runs on the free plan. The code is
`src/discord.js` (mixed into the Lair like the other rounds' modules) and the route in `src/index.js`.

Everything stays switched off until the Discord app's keys are in Cloudflare (section 2), so this can be deployed first.

## 1. What people can do in Discord

| Command | Who | What |
|---|---|---|
| `/games` | anyone in the server | the public games board for the next fortnight (a series shows its next session only), seats left, and a list to pick one from |
| `/events` | anyone | the calendar's dates for the next fortnight, places left (or "just turn up"), and a list to pick one from |
| `/table day time people [hours] [setup]` | anyone | a table: one choice per room, then booked |
| `/mylair` | anyone | what's theirs still to come, and cancelling or taking things back |
| `/link` | anyone | how to link their Dice Goblin account, or which account is linked (with Unlink) |
| `/lair-setup` | Discord server managers (Manage Server or Administrator) | the channels, the role to ping and the switches (section 6) |

Every answer is private (ephemeral: only the person who asked sees it). A pick from a list opens that session or event as a
card; its buttons change the card in place. A public post's buttons (section 7) answer with a new private message.

**Who they are.** A Discord account linked to a Dice Goblin account (section 5) books as that member: their name, verified
account email (or profile email) and profile mobile fill in, the booking is on their account (My Lair, loyalty stamps,
member pricing and limits all as on the website), and with a mobile on their profile a seat, sign-up, table or interest is
one tap. Anyone else books as a guest, as the website allows, through a pop-up asking what the website asks: name, email
and mobile, plus friends and notes where the website has them. A pop-up only asks a linked member for what their profile
is missing.

Discord acts as a customer, never as staff, even for a member tagged `staff`: every booking goes through the same route
as the website's (`createBooking`, `joinEvent`, `addInterest`, `joinWaitlist`, `joinSeries`, `updateBooking`,
`cancelJoin`, `removeInterest`, `leaveSeries`) with the same checks, the per-person soft limit keyed on the Discord user
(`discord:<id>`, 20 in 10 minutes) and the 6-upcoming-bookings-per-email limit. Problems come back in the website's own
words ("Only 2 seats left.", "That mobile number doesn't look right. Try one like 021 123 4567.").

**One tap at a time.** Each Discord user's taps run one after the other: a second tap waits for the first (up to 10
seconds), then finds what the first one made. So a double tap, or a pop-up sent twice, never books twice, even while the
first is waiting on Shopify (a checkout, the rules). Other people's taps don't wait.

**A guest's email.** A guest (not linked) can't use an email that's already on someone else's interest, Maybe or waitlist
place for that session or date ("That email is already on this one. If it's yours, link your account with /link to change
it."), or already on that date's sign-ups ("That email is already on the list for this one."). The website's own rule
would change that person's row, so the bot refuses instead. Their own earlier answer is theirs to change.

**TTRPG sessions** (a card): **Grab a seat** (one seat; disabled and reading "Full" when full), **Bring friends** (a seat for
each friend, one name per line, up to 8 seats in all; with a seat already, seats for the friends only), **I'm interested**
(the GM is emailed, round 9; nothing is booked), **Save my seat every week** (series only: a weekly regular, round 5; needs
a linked account, since the member code is the ticket; the answer says "A seat you keep is yours to pay for, even if you
don't come"), and a link to the game on the website. Someone who already has a seat sees **Bring friends** and **Drop my
seat** instead, and a second tap on Grab a seat never books twice. Someone who said they're interested sees **Not
interested now**. A regular sees **Stop coming every week**, and tapping Save my seat every week again (on a public post)
says "You're already a regular at …, with 2 seats saved every session (Ruby Tane, Kiri). To change who's coming, use My
Lair." and leaves their seats as they are.

**Events** (a card): with places, **Sign up** (one person) and **Bring friends** (names, or member codes so the stamp goes
on their card, up to 5: round 8's guests; a line is a member code only when a member has that code, so "Friend 1" is a
name); full, **Join the waitlist** (round 11: nothing is booked, the team hears; a guest says how many, 1 to 6); with no
sign-ups and no game tables, **I'm coming**; and **Maybe** on every date. On someone's own card these follow what they
said: **Not coming now**, **Not a maybe now**, or, on the waitlist, **Leave the waitlist** (and no Maybe). Someone on the
waitlist who taps Join the waitlist again is told so ("You're already on the waitlist for … (3 people).") and keeps how
many; tapping Maybe keeps their place in the queue ("You're on the waitlist for …, so Gobgob's kept your place in the queue
as it is."). An event paid
online answers with a **Pay now** checkout link: "Gobgob is holding your spot at … for 30 minutes. Pay online to keep it.
Paid online means you're locked in." An event with game tables links to the website for them (1 v 1 and 2 v 2 take player
codes: round 11).

**Tables**: `/table` takes a day (the box offers the next open days in the booking horizon: "Today, Fri 9 Oct", "Tomorrow,
Sat 10 Oct", "Sun 11 Oct"; typing "sat" or "17/10" works too), a start time (the box offers that day's whole hours that
leave room for the booking, 2 hours when hours is left out, none inside the lead time), how many people (1 to 24), hours (1
to 8, 2 when left out) and
the setup ("Board or card games", "Wargame (double tables)", "Big box game (double tables)", the booking page's extras).
The answer is a button per room that's bookable online and fits them (the Fancy room only for its minimum of 4): the
fewest tables that seat them, doubled for a wargame or big box game, side by side where they can be, free for the whole
time, with the price ("Common room: T1 + T2 · $40"). Shop tables count only when staff have opened them, as on the
booking page. A table's button holds the room's place in the list and each table's place in the room, with a fingerprint
of their ids (so any layout's ids work, and a button from before the rooms changed is refused). The house rules about the
time come back as the booking page says them ("That time is too soon to book online. Walk in instead.", "We're closed at
that time.", "That time is outside opening hours."). With every table taken, it offers up to three nearby start times
("Try 4pm"); with none, "The Lair's packed at that time. Try another day, or call us and we'll see what we can do." A
second tap on a choice they've booked says "You've already got **Table T1** at that time. Gobgob's guarding it." If
someone else takes the table in the moments between choosing and tapping, the answer is the choices left, with "Someone
just grabbed that table. Here's what's left:".

**/mylair**: bookings and seats (`table`, `gm-seat`), sign-ups and interests still to come that are on their account or
were made through the bot, and for a linked member the games they're a regular at. Each line: what, when, the code and
what's due at the counter. A list cancels one ("Cancel: Table T5", "Drop: Curse of Strahd", "Take back: …", "Stop: …"),
asking first. Only their own things can be asked about or cancelled: both look it up among their own first, so a button
for anything else says "That's already gone." (and the website's owner rule would refuse it anyway).

## 2. Setting it up (Mo, about 10 minutes)

1. **Make the app**: discord.com/developers/applications → New Application, "Dice Goblin" (Gobgob's picture as its icon).
2. **General Information**: copy the **Application ID** and **Public Key**.
3. **Bot**: Reset Token, copy the **token**. No privileged intents are needed. Turn **Public Bot** off, so only Mo can add it.
4. **OAuth2**: copy the **Client Secret**, and add the redirect `https://www.dicegoblin.nz/pages/my-lair` (exactly that).
5. **Cloudflare** → Workers & Pages → dice-goblin-lair → Settings → Variables and Secrets: add `DISCORD_BOT_TOKEN` and
   `DISCORD_CLIENT_SECRET` as **Secrets** (type Secret). Then the D1 database `dice-goblin-lair-config`, table `config`:
   `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` (neither is secret). The two secrets can't go in the config table:
   `src/config.js` doesn't read them from it.
6. **Discord → General Information → Interactions Endpoint URL**: `https://dice-goblin-lair.dicegoblinnz.workers.dev/discord/interactions`,
   then Save. Discord checks it there and then, so give the config table a minute to be read first (it's kept for a
   minute).
7. **Add the bot to the server**: open `/setup?key=<SETUP_KEY>&discord=commands` on the Lair's address: its `discord`
   block has `installUrl` (the bot, its slash commands and the permissions it needs: `326417730560`, which is view
   channels, send messages and send in threads, make public threads, embed links, read history, manage threads, and
   mention everyone so a seat ping can mention the role picked even when it isn't set as mentionable). Open it, pick
   the Dice Goblin server, and approve. The same `/setup` registered the slash commands (they can take a few minutes to
   appear the first time).
8. **In Discord, as the app's owner**: `/lair-setup` in the Dice Goblin server. The first time, it ties Gobgob to that
   server; only the Discord app's owner (or its team) can do that, so it must be Mo's account. Then pick the channel for
   TTRPG sessions and the one for events (the same one is fine; a forum works too, as long as it doesn't need a tag on
   every post), and the role to ping when a seat opens. Posts go up within seconds; the panel's **Posts** line says how
   many are up, and **Heads up** says if Discord refused any.

Until then, only `/lair-setup` answers: everything else gets "Gobgob isn't set up yet. The Discord app's owner runs
/lair-setup in the Dice Goblin server first." `DISCORD_GUILD_ID` (config, optional) names the server instead (it isn't
secret: right-click the server › Copy Server ID). Interactions from anywhere else (another server, a DM) get "Gobgob only
works in the Dice Goblin server." `DISCORD_REDIRECT_URI` (config, optional) changes where Link Discord comes back to (My
Lair when empty).

## 3. `POST /discord/interactions` (the Worker)

- `503 { error }` until `DISCORD_PUBLIC_KEY` is set.
- `401 invalid request signature` unless `X-Signature-Ed25519` is a valid Ed25519 signature, by the app's public key, of
  `X-Signature-Timestamp` followed by the raw body (Web Crypto `Ed25519`). Discord sends bad signatures now and then to
  check this.
- A PING (`type: 1`) gets `{ type: 1 }`.
- Everything else goes to the Lair (`POST /internal/discord/interaction`, the interaction as sent), whose answer is the
  response. If the Lair hasn't answered in 2.4 seconds (Discord allows 3), the Worker answers at once with a deferred
  response (`{ type: 5, data: { flags: 64 } }`, or `{ type: 6 }` for a private card that changes in place; empty choices
  for the day and time boxes) and, when the Lair's answer comes, edits it in (`PATCH
  /webhooks/<application id>/<token>/messages/@original`). A pop-up can't come late (Discord only opens one as the
  first answer), so then only the words change, to "Gobgob took a moment there. Tap the button again." (a private card
  keeps its embeds and buttons, so there's still something to tap).
- If the Lair fails, the answer is "⚠️ Something went wrong on Gobgob's side. Try again, or book on dicegoblin.nz.",
  never the Lair's error.

Button and select ids are `dg:<action>:…` (100 characters at most): `pick` (a list: `g:<game id>` or `e:<date ref>`),
`list`, `seat`, `friends`, `int`, `every`, `join`, `jfr`, `wait`, `coming`, `maybe`, `table`, `tmore`, `mine`, `ask`, `drop`,
`keep`, `unlink`, `set`; pop-ups `mseat`, `mint`, `mevery`, `mjoin`, `mwait`, `mev`, `mtable`. An event date's ref is its
handle's 10-character fingerprint and the day (`k3j9x0a1bc@20261014`), since handles can be long. Ids from a button are
never trusted: each is checked for shape, and everything it leads to goes through the Lair's own checks.

Pop-ups use Discord's current shape (each text box inside a Label, type 18); answers in the older Action Row shape are
read too.

## 4. Ownership: what someone made through the bot

`discord_items (kind, item_id, user_id, item_key)`: every booking (`booking`), sign-up (`join`) and interest (`interest`)
made through the bot, with the Discord user who made it (and a guest interest's key, `item_key`). The handlers write it in
the same step as the row itself (`discordMade`, from `who.discordUserId`, which only the bot sets), so it's there before
anything they wait on, and only for a row the call made: never one an email matched (the website's interest and waitlist
rule updates a matching row; that row stays whoever's it was). Two rules use it, and only while the row is on nobody's
account (once it's on an account, that account owns it):

- `updateBooking`'s owner path and `cancelJoin`: the owner is the account it's on, **or the Discord user who made it**. So
  a guest can drop a seat or sign-up they made in Discord, from Discord, as a logged-in member can on the website. Nobody
  else can.
- Linking (section 5): what they made as a guest that's upcoming or ended in the last 30 days joins their account (like
  `adoptGuestBookings`), and a second interest in the same session or date is taken back. Linking the same Discord account
  to another member later takes nothing along.

When the website's interest or waitlist rule later puts someone else's details into a row the bot made (they used the
same email), that row stops being the Discord user's (`discordTouched`): it leaves their /mylair and never joins their
account. The same Discord user changing their own row keeps it.

A guest interest is taken back with its stored key (`removeInterest`'s guest path).

## 5. Link Discord (the website)

Discord's own sign-in (OAuth2, scope `identify`), bound to the member who started it:

- **`POST /me/discord/start`** (logged in) → `{ url }`: Discord's authorize page (`response_type=code`, `client_id`,
  `scope=identify`, `redirect_uri`, `state`, `prompt=none`). The state (`dg` and 32 hex characters, random) is theirs
  alone, for 10 minutes, once. 401 logged out; 503 "Discord linking isn't switched on yet." without
  `DISCORD_APPLICATION_ID` and `DISCORD_CLIENT_SECRET`.
- Discord sends them back to My Lair (`https://www.dicegoblin.nz/pages/my-lair?code=…&state=…`; `?error=access_denied`
  when they say no). My Lair sends the two on:
- **`POST /me/discord/finish { code, state }`** (logged in): the state must be one this member started in the last 10
  minutes and never used (it's claimed before Discord is asked, so it works once). Discord swaps the code for who they are
  (`POST /oauth2/token`, then `GET /users/@me`): only their Discord id, username and display name are kept, and the token is
  revoked straight away. That Discord account is linked to this member, one to one (an earlier link of either is
  replaced). → `{ discord, adopted }` (`adopted`: how many bookings, sign-ups and interests joined the account).
  422 "That Discord link has expired. Tap Link Discord again." (a wrong, used, someone else's or old state); 422
  "Discord didn't let Gobgob in. Tap Link Discord and try again." (Discord refused the code); 502 "Discord didn't answer
  just now. Try again in a minute."
- **`POST /me/discord/unlink`** (logged in) → `{ ok, discord }`. Bookings stay as they are.
- **`GET /me`** adds `discord: { ready, linked: { username, name, at } | null }` (`ready`: Link Discord is switched on).

In Discord, `/link` shows the account linked (name and member code) with **Unlink**, or a **Link my account** button to
`/pages/my-lair?link=discord#profile`, where My Lair starts linking by itself.

## 6. `/lair-setup`

Discord server managers only: the command is hidden from everyone else (`default_member_permissions` Manage Server), and
every click is checked again against the member's permissions in the interaction. The first `/lair-setup` ties the bot to
its server (unless `DISCORD_GUILD_ID` names one), and only the Discord app's owner can run that one: Gobgob asks Discord
(`GET /applications/@me`, at most hourly) and accepts the owner, or the team's owner and its accepted members. Anyone
else hears "Only the Discord app's owner can tie Gobgob to a server the first time.", and when Discord can't be asked,
"Gobgob couldn't check who owns the app just now. Try again in a minute, or put this server's ID in the config table as
DISCORD_GUILD_ID." After that, any manager in that server can use the panel. A private panel with:

- a channel picker for TTRPG sessions and one for events (text, announcement or forum channels; empty means that kind isn't
  posted); a role picker for seat pings (optional). Picking a forum that needs a tag on every post says so: "Heads up:
  that forum needs a tag on every post, and Gobgob can't add one. Turn off Require Tags in its settings, or pick a text
  channel.";
- **Auto-posts**, **Seat pings** and **Round-up** switches (all on to start), and **Post now** ("Gobgob's posting now. Give
  it a minute, then check the channel."). Post now, and any change on the panel, tries again at once whatever Discord
  refused before;
- **Posts**: how many are up, and how many are still to go up;
- **Heads up**, when there's something to fix: the bot's token isn't in Cloudflare yet; "Gobgob can't post in #channel.
  Check the bot can see it, send messages, embed links and make threads there." (Discord's 50001 or 50013); "#channel is a
  forum that needs a tag on every post. …" (40067); "One of the channels picked doesn't exist any more. Pick another."
  (10003); or Discord's own reason.

Kept in `discord_settings` (`guild`, `sessions_channel`, `sessions_type`, `events_channel`, `events_type`, `ping_role`,
`posts`, `pings`, `digest`), with who changed each and when.

## 7. Posts in the server

When the bot has its token, a channel is picked and Auto-posts is on:

- **TTRPG sessions**: every session on the public board up to the booking horizon gets a post in the sessions channel:
  one post for a whole series (moved on to its next session as each one ends: the same message, so the same thread and
  chat), one per one-off. The card: title (linking to the game on the website), the blurb, when (Lair time, and Discord's
  "in 3 days"), seats left of seats ("Full right now"), the price ("$15 a seat, at the counter"), GM, system, one-shot or
  how it repeats, level and ages, the game's picture, and the session's buttons (Grab a seat, Bring friends, I'm
  interested, Save my seat every week, On the website). In a text or announcement channel a thread is started from the post,
  named after the game, for its chat; a forum post is its own thread.
- **Events**: each date in the next 7 days gets a post in the events channel (a week ahead, so a weekly event doesn't fill
  the channel): title (linking to the date on the calendar), its description, when, places left of the capacity (or "No
  need to sign up. Just turn up!"), the price line the reminder emails use, how many said they're coming or maybe, and the
  date's buttons. No thread.
- **Up to date**: posting happens in the Durable Object's alarm, never inside a booking or the maintenance, so each round
  has its own allowance of outside calls (the free plan allows 50 an invocation). After a booking, seat, sign-up,
  interest or session changes (any write to those tables), the alarm is set for 2 seconds later, once for a burst. The
  10-minute maintenance sets it only when the posts have something to do or the round-up is due. A post is edited only
  when what it shows changed (its content's fingerprint, `discord_posts.hash`). A round starts no new job once it has made
  12 Discord calls (a job can take up to 4, so about a dozen in all) and never runs twice at once; when there's more, the
  next round is a second later. While the store's rules haven't loaded (Shopify didn't answer after a restart, so the
  built-in defaults stand in, with no events), nothing is posted, edited, taken down or rounded up: the posts wait for the
  real rules rather than take every event date down.
- **Discord's limits**: waits are per channel (Discord's buckets), from a 429's `retry_after` (or a bucket with
  `X-RateLimit-Remaining: 0`, until its `X-RateLimit-Reset-After`), so Gobgob never sends a call Discord said to wait for,
  and other channels carry on. A global 429 holds every call, and a refused token (401) holds every call for an hour.
  Waiting never counts against a post.
- **Seat pings**: when a session or event in the next 7 days that was full (seats or places left 0 when its post last
  changed) has room again, a message goes up in the channel ("@Role A seat just opened up at **Curse of Strahd** (Thu 15
  Oct, 6pm). Just the one, so be quick." or "3 going."), with its Grab a seat (or Sign up) button. In a forum it goes in
  the post's thread. At most one ping per post every 30 minutes, and never when a series' post moves on to its next
  session (a new session isn't a seat opening up). The ping is claimed, with the seats it shows, before it's sent, so a
  post whose edit is failing doesn't ping the same seat again. It mentions only the role picked (`allowed_mentions` names
  it), and posts never mention anyone.
- **Closing off**: a post that's no longer wanted says why. An event date's post in a text or announcement channel is
  deleted, so the channel stays a list of what's on. A session's post is edited to say why, with no buttons, only a link
  (its chat thread stays); a forum post is edited the same way and archived. The words: "This session has been played.
  Gobgob hopes the dice were kind.", "No more sessions on the calendar for this one.", "This session was cancelled.",
  "This one's been and gone. See you at the next one!", "This date isn't on the calendar any more.", "This one is off the
  board for now." Its row is set aside, so the same session or date gets a fresh post if it comes back.
- **The midday round-up**: once a day from midday (Lair time), today's sessions and events that still have room, in one
  message with a list to pick from ("Still room at the Lair today:"), when there are any. It goes in the sessions channel
  (or the events one), never in a forum, and doesn't buzz anyone (`SUPPRESS_NOTIFICATIONS`).
- **When things go wrong**:
  - A post or edit Discord refused (no permission in the channel, say) is tried again after 30 minutes, then 1, 2 and 4
    hours, then every 8 hours, and never given up, with the reason in `discord_posts.error` and on the panel. Post now
    (or `/setup?…&discord=sync`) tries again at once. Closing off a post is given up after 10 refusals.
  - A call that may or may not have happened (a 5xx, or no answer within 10 seconds) doesn't count against the post. A
    create like that is marked `unsure`, and 30 seconds later Gobgob looks for it before making another: a message by
    the bot in the channel's last 50 with the post's link (compared as an address, however Discord writes it back), or,
    in a forum, an active thread in that forum with the post's name, made since the post was first claimed. Found, it's
    used; not found, it's made. A create claimed more than a minute ago with no answer (the Lair restarted mid-call) is
    looked for the same way. Text-channel creates also carry a nonce.
  - Discord's limit on edits to messages over an hour old (30046) is tried again after 15 minutes, not counted.
  - A session's chat thread Discord didn't make is made later (when Discord says, after 30 seconds, or 6 hours after a
    refusal); one that's there already (160004) is used, its id being the message's.
  - A post deleted in Discord goes up again; a forum thread that went quiet (archived) is opened again before its post
    is edited.
  - Picking another channel leaves the old posts where they are and puts new ones up in the new channel at once, even one
    Discord refused before.
- **On the website**: `GET /floor` adds `discordUrl` to each game (its post's thread, or the post until the thread is
  made; one for every session of a series) and `eventDiscord: { [occurrenceId]: url }` for the dates with a post. The theme
  shows "Chat on Discord".

## 8. Upkeep, `/setup` and the status table

The 10-minute maintenance (and `/setup`) adds a `discord` block to its answer and the status table's `connection` row:
`interactions`, `linking`, `posting`, `botToken` (true or false, never the value), `guild`, the channels and role, the
switches, `posts` (counts by status), `problems` (up to 5 posts with Discord's reason, their tries and when they're next
tried), `pending` (how many posting jobs are waiting), `waitingForRules` (when the store's rules haven't loaded),
`interactionsUrl`, `redirectUri`, `installUrl`, `linkedMembers` and `commands`. It registers the slash commands with Discord (`PUT /applications/<id>/commands`, global, in servers only) when
they or the app change, trying again an hour after a refusal, and sets the alarm when the posts have something to do or
the round-up is due (section 7). A round with failures notes them in the status table's `discordPosts` row.
`/setup?key=…&discord=commands` registers the commands again now; `&discord=sync` tries again now whatever Discord
refused before.

## 9. Storage (one migration entry, new tables only)

- `discord_links (user_id PRIMARY KEY, customer_id UNIQUE, username, global_name, linked_at, updated_at)`
- `discord_states (state PRIMARY KEY, customer_id, created_at, used_at)`: cleared after a day
- `discord_items (kind, item_id, user_id, item_key, created_at; PRIMARY KEY (kind, item_id))`, index on `(user_id, kind)`
- `discord_posts (id PRIMARY KEY, kind, target_id, channel_id, channel_type, message_id, message_channel, thread_id,
  status, hash, seats_left, pinged_at, title, starts_at, url, tries, retry_at, unsure, thread_retry_at, error, created_at,
  updated_at)`, index on `(status, starts_at)`. `id` is `s:<series id>`, `g:<game id>` or `e:<occurrence id>`; set aside as
  `<id>~<ms>` when a post ends, moves or is deleted. `status` is `creating`, `live`, `failed` (not up yet: tried again at
  `retry_at`), `ended`, `moved` or `gone`. `tries` counts refusals in a row; `unsure` marks a create that may have gone
  up; `url` is the post's link (how it's found again); `thread_retry_at` is when a missing chat thread is tried again.
- `discord_settings (key PRIMARY KEY, value, updated_at, updated_by)`
- meta keys `discord-commands` (what was registered and when) and `discord-digest` (the day the round-up went).

Discord account ids, usernames and display names are the only Discord data kept. Nothing from Discord is ever put in a
post's text, and no Discord token is stored.

## 10. Found on the way: the clash check

`POST /bookings` passed the request's `ignoreBookingId` and `game` straight into the house rules. Booking ids are on the
public floor, so anyone could book a table that was already taken by sending that booking's id as `ignoreBookingId`, and
`game: true` let one person take a GM's two tables. Both are now the Lair's own (only `checkGameSession` sets them), and a
test covers it.

## 11. The theme (branch `discord-theme`, a pull request into `dice-goblin-2-theme`)

- **My Lair › Profile**: a Discord card, between the player profile and the GM profile, shown once GET /me says Link
  Discord is switched on (`discord.ready`) or they're linked: "Link Discord" (`POST /me/discord/start`, then off to
  Discord), or the account linked with "Unlink" (asked first: "Unlink your Discord? Gobgob won't know it's you in the
  server any more. What you've booked stays booked."). Coming back from Discord (`?code=…&state=…`, a state starting
  `dg`), My Lair takes the code out of the address at once, finishes it (`POST /me/discord/finish`) and says how it went
  ("Linked! Gobgob knows you as Ruby in the Dice Goblin server now.", or the Lair app's words);
  `?error=access_denied` says "No worries, your Discord isn't linked. Tap Link Discord whenever you're ready."
  `?link=discord` (the bot's Link my account button) opens Profile and starts linking by itself; logged out, My Lair's
  Log in button comes back to it (`return_to` for new customer accounts, `return_url` for classic ones).
- **TTRPG sessions** and the **events calendar**: "Chat on Discord" (opens in a new tab) on a session's sheet when its game
  has a `discordUrl`, and on a date's sheet when `eventDiscord` has it, while it's still to come. Only discord.com and
  discord.gg addresses are ever shown.
- **Demo** (`assets/lair-demo.js`): the same routes, faked. Link Discord comes straight back with a made-up code and links
  a made-up account; "Chat on Discord" goes to the shop's Discord (Theme settings › Social), which `lair-config` now
  passes on as `shop.discord`.

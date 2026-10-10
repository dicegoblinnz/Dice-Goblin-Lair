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

**TTRPG sessions** (a card): **Grab a seat** (one seat; disabled and reading "Full" when full), **Bring friends** (a seat for
each friend, one name per line, up to 8 seats in all; with a seat already, seats for the friends only), **I'm interested**
(the GM is emailed, round 9; nothing is booked), **Save my seat every week** (series only: a weekly regular, round 5; needs
a linked account, since the member code is the ticket; the answer says "A seat you keep is yours to pay for, even if you
don't come"), and a link to the game on the website. Someone who already has a seat sees **Bring friends** and **Drop my
seat** instead, and a second tap on Grab a seat never books twice.

**Events** (a card): with places, **Sign up** (one person) and **Bring friends** (names, or member codes so the stamp goes
on their card, up to 5: round 8's guests); full, **Join the waitlist** (round 11: nothing is booked, the team hears; a guest
says how many, 1 to 6); with no sign-ups and no game tables, **I'm coming**; and **Maybe** on every date. An event paid
online answers with a **Pay now** checkout link: "Gobgob is holding your spot at … for 30 minutes. Pay online to keep it.
Paid online means you're locked in." An event with game tables links to the website for them (1 v 1 and 2 v 2 take player
codes: round 11).

**Tables**: `/table` takes a day (the box offers the next open days in the booking horizon: "Today, Fri 9 Oct", "Tomorrow,
Sat 10 Oct", "Sun 11 Oct"; typing "sat" or "17/10" works too), a start time (the box offers that day's whole hours that
leave room for the booking, none inside the lead time), how many people (1 to 24), hours (1 to 8, 2 when left out) and
the setup ("Board or card games", "Wargame (double tables)", "Big box game (double tables)", the booking page's extras).
The answer is a button per room that's bookable online and fits them (the Fancy room only for its minimum of 4): the
fewest tables that seat them, doubled for a wargame or big box game, side by side where they can be, free for the whole
time, with the price ("Common room: T1 + T2 · $40"). The house rules about the time come back as the booking page says
them ("That time is too soon to book online. Walk in instead.", "We're closed at that time.", "That time is outside
opening hours."). With every table taken, it offers up to three nearby start times ("Try 4pm"); with none, "The Lair's
packed then. Try another day, or call us and we'll see what we can do." If the table goes in the moments between
choosing and tapping, the answer is the choices left, with "Someone just grabbed that table. Here's what's left:".

**/mylair**: bookings and seats (`table`, `gm-seat`), sign-ups and interests still to come that are on their account or
were made through the bot, and for a linked member the games they're a regular at. Each line: what, when, the code and
what's due at the counter. A list cancels one ("Cancel: Table T5", "Drop: Curse of Strahd", "Take back: …", "Stop: …"),
asking first. Only their own things can be asked about (they're looked up among their own); a button for someone else's
booking gets the website's 403.

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
8. **In Discord**: `/lair-setup`, pick the channel for TTRPG sessions and the one for events (the same one is fine; a
   forum works too), and the role to ping when a seat opens. Posts go up within a minute or two, or tap **Post now**.

`DISCORD_GUILD_ID` (config, optional) names the server; without it, the first `/lair-setup` ties the bot to the server it
was run in, and interactions from anywhere else (another server, a DM) get "Gobgob only works in the Dice Goblin server."
`DISCORD_REDIRECT_URI` (config, optional) changes where Link Discord comes back to (My Lair when empty).

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
  first answer), so then the message says "Gobgob took a moment there. Tap the button again."
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
made through the bot, with the Discord user who made it (and a guest interest's key, `item_key`). Two rules use it:

- `updateBooking`'s owner path and `cancelJoin`: the owner is the account it's on, **or the Discord user who made it**
  (`who.discordUserId`, which only the bot sets). So a guest can drop a seat or sign-up they made in Discord, from Discord,
  as a logged-in member can on the website. Nobody else can.
- Linking (section 5): what they made as a guest that's upcoming or ended in the last 30 days joins their account (like
  `adoptGuestBookings`), and a second interest in the same session or date is taken back.

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
its server (unless `DISCORD_GUILD_ID` names one). A private panel with:

- a channel picker for TTRPG sessions and one for events (text, announcement or forum channels; empty means that kind isn't
  posted); a role picker for seat pings (optional);
- **Auto-posts**, **Seat pings** and **Round-up** switches (all on to start), and **Post now** (a round of posting straight
  away, with how many went up);
- a line when the bot's token isn't in Cloudflare yet.

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
- **Up to date**: after a booking, seat, sign-up, interest or session changes (any write to those tables), a round of
  posting runs 2 seconds later, once for a burst; the 10-minute maintenance runs one too. A post is edited only when what
  it shows changed (its content's fingerprint, `discord_posts.hash`). A round makes 12 Discord calls at most (the rest
  wait for the next), never runs twice at once, and stops while Discord says to wait (429, for its `retry_after`) or
  for an hour after Discord refuses the token (401).
- **Seat pings**: when a session or event in the next 7 days that was full (seats or places left 0 when its post last
  changed) has room again, a message goes up in the channel ("@Role A seat just opened up at **Curse of Strahd** (Thu 15
  Oct, 6pm). Just the one, so be quick." or "3 going."), with its Grab a seat (or Sign up) button. In a forum it goes in
  the post's thread. At most one ping per post every 30 minutes. It mentions only the role picked (`allowed_mentions`
  names it), and posts never mention anyone.
- **Closing off**: a post that's no longer wanted is edited to say why, with no buttons, only a link: "This session has
  been played. Gobgob hopes the dice were kind.", "No more sessions on the calendar for this one.", "This session was
  cancelled.", "This one's been and gone. See you at the next one!", "This date isn't on the calendar any more.", "This one
  is off the board for now." Its row is set aside, so the same session or date gets a fresh post if it comes back.
- **The midday round-up**: once a day from midday (Lair time), today's sessions and events that still have room, in one
  message with a list to pick from ("Still room at the Lair today:"), when there are any. It goes in the sessions channel
  (or the events one), never in a forum, and doesn't buzz anyone (`SUPPRESS_NOTIFICATIONS`).
- **When things go wrong**: a post Discord refused (no permission in the channel, say) is tried again after 30 minutes, up
  to 5 times, with the reason in `discord_posts.error`; a create that never came back is tried again after 10 minutes with
  the same nonce, so it can't be doubled; a post deleted in Discord goes up again; a forum thread that went quiet
  (archived) is opened again before its post is edited. Picking another channel leaves the old posts where they are and
  puts new ones up in the new channel.
- **On the website**: `GET /floor` adds `discordUrl` to each game (its post's thread, or the post; one for every session of a
  series) and `eventDiscord: { [occurrenceId]: url }` for the dates with a post. The theme shows "Chat on Discord".

## 8. Upkeep, `/setup` and the status table

The 10-minute maintenance (and `/setup`) adds a `discord` block to its answer and the status table's `connection` row:
`interactions`, `linking`, `posting`, `botToken` (true or false, never the value), `guild`, the channels and role, the
switches, post counts by status, `interactionsUrl`, `redirectUri`, `installUrl`, `linkedMembers`, `commands` and the
round's `sync` and `digest`. It registers the slash commands with Discord (`PUT /applications/<id>/commands`, global, in
servers only) when they or the app change, trying again an hour after a refusal. `/setup?key=…&discord=commands`
registers them again now; `&discord=sync` posts now, even while Discord said to wait.

## 9. Storage (one migration entry, new tables only)

- `discord_links (user_id PRIMARY KEY, customer_id UNIQUE, username, global_name, linked_at, updated_at)`
- `discord_states (state PRIMARY KEY, customer_id, created_at, used_at)`: cleared after a day
- `discord_items (kind, item_id, user_id, item_key, created_at; PRIMARY KEY (kind, item_id))`, index on `(user_id, kind)`
- `discord_posts (id PRIMARY KEY, kind, target_id, channel_id, channel_type, message_id, message_channel, thread_id,
  status, hash, seats_left, pinged_at, title, starts_at, tries, error, created_at, updated_at)`, index on
  `(status, starts_at)`. `id` is `s:<series id>`, `g:<game id>` or `e:<occurrence id>`; set aside as `<id>~<ms>` when a
  post ends, moves or is deleted. `status` is `creating`, `live`, `failed`, `ended`, `moved` or `gone`.
- `discord_settings (key PRIMARY KEY, value, updated_at, updated_by)`
- meta keys `discord-commands` (what was registered and when) and `discord-digest` (the day the round-up went).

Discord account ids, usernames and display names are the only Discord data kept. Nothing from Discord is ever put in a
post's text, and no Discord token is stored.

## 10. Found on the way: the clash check

`POST /bookings` passed the request's `ignoreBookingId` and `game` straight into the house rules. Booking ids are on the
public floor, so anyone could book a table that was already taken by sending that booking's id as `ignoreBookingId`, and
`game: true` let one person take a GM's two tables. Both are now the Lair's own (only `checkGameSession` sets them), and a
test covers it.

## 11. The theme (built with this round)

- **My Lair › Profile**: a Discord card. With Link Discord switched on (`discord.ready`): "Link Discord" (`POST
  /me/discord/start`, then off to Discord), or the account linked with "Unlink". Coming back from Discord (`?code=…&state=…`
  with a state starting `dg`), My Lair finishes it (`POST /me/discord/finish`), takes the code out of the address and says
  how it went; `?error=access_denied` says it wasn't linked. `?link=discord` (the bot's Link my account button) opens
  Profile and starts linking.
- **TTRPG sessions**: "Chat on Discord" on a session's sheet when its game has a `discordUrl`.
- **Events calendar**: "Chat on Discord" on a date's sheet when `eventDiscord` has it.
- **Demo** (`assets/lair-demo.js`): the same routes, faked.

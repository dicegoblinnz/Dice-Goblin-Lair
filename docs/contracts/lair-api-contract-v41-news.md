# Lair contract v41: news emails (16 Nov 2026)

Mo, 16 Nov 2026: "Can we do our own marketing email to our customers? [...] Like adding new items added etc." After test copies of the weekly email and the Black Friday email reached his inbox: "I'm happy lets build it but don't send anything yet remind me again next week Monday to send one incase I changed my mind".

Built and deployed **switched off**. Nothing goes to customers until the config database's `NEWS_EMAILS` lists an email.

## The emails (src/news.js)

| Name in `NEWS_EMAILS` | What | When |
|---|---|---|
| `weekly` | "This week at the Lair": from now to Sunday, every event date (an event over days in a row once, like Oddity Alley) and every public TTRPG session with seats anyone can book (a weekly game's next session only), soonest first, at most 12; then "New in the hoard": products created on the website in the last 7 days, in stock, on the Online Store, never Games Workshop's or a library copy (4 shown with picture and price, the count of all, "See everything new"). Nothing on and nothing new: no email that week. | Mondays from 10am, made once; anything not sent by the end of Tuesday is let go |
| `black-friday-2026` | Buy one dice set, get one free, Friday 27 to Monday 30 November, double d20 rolls online, the fine print, and four of the newest Dice Goblin dice in stock. | Once, the first run after it's switched on, from 17 to 30 November; nothing goes after the 30th |

Pictures (Mo, later on 16 Nov 2026: "I want the game images be included with the events inside the email. Not just text for the events."): each event row leads with the event's picture from Shopify (lair_event `image`, read when the email is made; Shopify's CDN crops it to a 240 × 135 thumbnail, shown 120 wide) and each TTRPG session with its game's picture; a row with none gets a dark tile with its day in goblin green. If Shopify won't give the pictures, the email goes as the plain list. The plain-text copy is unchanged.

Words: `NEWS_WORDS` in src/news.js (Gobgob's voice; the deal's facts plainly). Links carry `utm_medium=email`, `utm_source` (`weekly-email`, `black-friday`) and `utm_campaign` (`events`, `ttrpg`, `tables`, `shop`).

## Who gets them

Only customers Shopify has `SUBSCRIBED` to email marketing (read 100 at a time when the email is made, up to 2,000 customers; past that it says so and doesn't send), less the Lair's stop list (`followup_stops`), checked again as each batch goes. New Zealand's Unsolicited Electronic Messages Act 2007: consent, the shop's details (the footer) and a working unsubscribe in every one.

## Unsubscribing

Each address has its own code and key (`news_keys`: `NEWS-<16 hex>`, 32 hex). The email's "Unsubscribe" link is My Lair's `#unsubscribe=<code>.<key>`, the same page and routes as the first-game email (`POST /unsubscribe/view`, `POST /unsubscribe/stop`), and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers point at the Lair's `/unsubscribe/<code>/<key>` (one-click, RFC 8058). Either puts the address on the stop list, which stops every marketing email from the Lair, and reaches Shopify's setting (first-game.js `pushStopsToShopify`). The theme needs no change.

## Sending

`news_campaigns` keeps each email as made; `news_sends` queues everyone it's for. The 10-minute run sends up to 100 in one Resend batch, 9am to 8pm, each row marked before it goes. Resend down or busy: back on the queue. No answer: `unknown`, never sent again. Refused: the batch is halved and tried again down to one email, which is marked `failed`; three refused in a row on their own pause the news emails (a sender or key fault, not an address) until the owner's job `news.resume`.

## Switches and jobs

- `NEWS_EMAILS` (config): comma list, e.g. `weekly,black-friday-2026`. Empty or `off`: nothing.
- `NEWS_FROM` (config): the sender for these, e.g. a marketing subdomain once Resend has verified it; `FROM_EMAIL` when unset.
- Admin jobs (`admin_jobs`): `news.test` `{ "campaign": "weekly" | "black-friday-2026", "to": "…", "at": ms }` sends one copy, "[Test]" on the subject, nothing queued; `news.status` says each email's counts (and why they're paused); `news.resume` starts sending again after a pause.
- `POST /internal/news-test` and `/internal/news-status`: the same, internally.

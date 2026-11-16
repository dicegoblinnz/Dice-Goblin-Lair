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

## Drafts and the staff page's Emails tab (17 Nov 2026)

Mo: "can we have it automated inside the staff section to be sent as a weekly template with the chance to edit any possible changes if not just the ability to send the email from staff is good enough".

Every email is a draft first (`news_campaigns.status` `draft`, `base` the Lair's words and products, `edits` the owner's changes), and `queued` once it's sent (`content` what went, `sent_at`, `sent_by`: `auto` or the staff member). The Lair makes each Monday's weekly draft from 7am by itself. NEWS_EMAILS still sends a draft by itself (the weekly at 10am, a one-off when due), made again from the calendar and the shop first with the owner's changes kept.

Owner only (`requireStaff(who, 'news')`: not a permission a helper can be given):

| Route | What |
|---|---|
| `GET /news` | `{ ready, on, paused, week, kinds: [{ kind, label }], emails: [{ id, kind, label, status ('draft' or 'sent'), madeAt, updatedAt, sentAt, sentBy, until, expired, skipped, subject, edits: { subject, preheader, intro, note, hideNew }, defaults: { subject, preheader, intro }, agenda: [{ key, when, title, detail, image, hidden }], tiles, newStock: { heading, tiles } , recipients, counts: { sent, waiting, failed, stopped, expired }, preview (HTML) }] }`, the last 12 |
| `GET /news/audience` | `{ count }`: subscribed in Shopify, less the stop list |
| `POST /news/draft { kind }` | this week's weekly draft (or Black Friday's in its days), made if it isn't there |
| `POST /news/:id { subject, preheader, intro, note, hide: [key], hideNew }` | the owner's changes; a word field sent empty goes back to the Lair's own words; limits 120, 200, 1200 and 1200 characters |
| `POST /news/:id/refresh` | made again from the calendar and the shop, changes kept |
| `POST /news/:id/test { to }` | one copy, "[Test]" on the subject, to `to` or the owner's account email |
| `POST /news/:id/send` | to everyone it's for now; the first batch straight away from 9am to 8pm |

A weekly with no event, session or product left in can't be sent (422), by the tab or by NEWS_EMAILS. The note shows in a box under the opening words. The website's side is the theme's `assets/lair-staff-news.js` (the Emails tab, under Setup).

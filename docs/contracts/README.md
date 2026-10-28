# Lair API contracts

These are the specs each build round was written against. Read them newest first: where two disagree, the newer one wins.

| File | Round | Date |
|---|---|---|
| `lair-api-contract-v22-holds.md` | Round 22, every hold can be edited: an event's held tables change for one date (Edit, Free the tables, Back to usual) or every date to come, and staff holds get Edit, with a weekly hold's dates changed one at a time or all together; the staff page lists each event once with its dates under it (Mo, 28 Oct 2026) | 28 Oct 2026 |
| `lair-api-contract-v22-stamps.md` | Round 22, stamps: a session stamps once it's checked in or paid in full on its day (no account on it: the payer); the Session product rung up by hand stamps the sale's customer (SKU `LAIR-SESSION…`); staff add and undo stamps (counter, member's page, check-in card); scanning a code puts the person on the sale; and card payments at the counter (Pay on Verifone, which drops line properties) are read by the code in each line's title, and tabs by their items | 28 Oct 2026 |
| `lair-api-contract-v21-tables.md` | A session's new tables for its later sessions too: Edit session asks "This and every later session" or "Just this session"; later sessions move where the tables are free that day, and the weekly game keeps them for sessions it adds later | 27 Oct 2026 |
| `lair-api-contract-v21-gm-cover.md` | Round 21, part 2, a GM pays for one of their players: the seat costs the player nothing, the GM's charge (the $10 table part) goes on the GM's account, no GM credit for it; website and counter, until the player has paid. The charge follows the seat, is locked in 24 hours before like any seat, and money back to the GM is worked out from what they've paid, net. A player who doesn't come pays the full price on their own tab (Mo, 27 Oct 2026) | 26 to 27 Oct 2026 |
| `lair-api-contract-v21-gm-credit.md` | Round 21, GMs' stamps and GM credit that adds itself: a stamp for each session a GM ran (not staff), and from 26 Oct 2026 each paid seat gives its GM their fee once the session is over | 26 Oct 2026 |
| `lair-api-contract-v20-sessions-feed.md` | Round 20, the TTRPG page's sessions in the page: the next two weeks of public sessions in the shop metafield `lair.sessions` for the theme to print (no GM names, no private games) | 26 Oct 2026 |
| `lair-api-contract-v19-report.md` | Round 19, the weekly numbers: regulars, the staff report and email, and the website's anonymous booking steps | 24 Oct 2026 |
| `lair-api-contract-v18-gm-players.md` | A GM sees their players on every session: regulars' saved seats listed (and messaged), and a series' GM sees every session's players | 17 Oct 2026 |
| `lair-api-contract-v18-private.md` | Private games: invite only, with an invite link the GM shares, and Register interest | 17 Oct 2026 |
| `lair-api-contract-v18-cash.md` | Cash at the counter: members tap Pay with cash, staff tick it off (checked in and paid), and Shopify gets a paid order | 17 Oct 2026 |
| `lair-api-contract-v18-open-seats.md` | Open seats for launch (the groups' own players off every session) and taking a regular off every session | 16 Oct 2026 |
| `lair-api-contract-v18-gm-sessions.md` | Round 18, more for GM sessions: staff GMs run their own game, seats for new players, free sessions, a new GM | 16 Oct 2026 |
| `lair-api-contract-v17-staff-gm-credit.md` | Round 17, GM credit for staff (never, in their hours, or like any GM) and the team's hours | 16 Oct 2026 |
| `lair-api-contract-v16-library-lending.md` | Library lending: staff lend games to anyone, with no plan or no account, at no charge | 16 Oct 2026 |
| `lair-api-contract-v16-wishlist.md` | Round 16, the wishlist (built, switched off) | 16 Oct 2026 |
| `lair-api-contract-v16-library-returns.md` | Library returns: members only borrow, staff put games back on the shelf | 16 Oct 2026 |
| `lair-api-contract-v13-feeds.md` | Round 13, follow a game (the Our games page) | 10 Oct 2026 |
| `lair-api-contract-v12-sim.md` | Round 12, the website simulation's fixes | 10 Oct 2026 |
| `lair-api-contract-v10-memberships.md` | Round 10, library memberships | 9 Oct 2026 |
| `lair-api-contract-v7.md` | Round 7 | 6 Oct 2026 |
| `lair-api-contract-v6.md` | Round 6, part 1 | 5 Oct 2026 |
| `lair-api-contract-v5.md` | Round 5 | 4 Oct 2026 |
| `lair-api-contract-v4.md` | Round 4 | 3 Oct 2026 |
| `lair-api-contract-v3.md` | Round 3 | |
| `lair-api-contract-v1.md` | Base contract | |

Round 10, library memberships, covers: the Lair billing Grab, Stash and Hoard itself through a second Shopify app (Lair
Memberships) in place of Simplee; failed payments, bank checks and retries; plan changes and cancelling; damage
charges on the member's next bill after a 7-day notice; the staff Memberships and Damage routes; setting it up and
switching over; what to check before billing goes on; and taking a damage charge straight away from store credit or the saved card.

Round 7 covers: mobile numbers on bookings, the player profile, roll codes and "Got a code?", the loyalty card's number, birthday gifts in words and claimed gifts, library holds until midnight with games at home and scanning, the tab scanner, the customer picker, groups and their passes, the events editor, staff TTRPG sessions with GM invites, and seats staff add or reserve. Its last sections split the theme work into modules for parallel agents.

Round 6, part 1 covers (each section ends with what was built and where it differs):
- the loyalty card, which replaces the spend dice
- spend by month and financial year
- session gifts
- library holds
- joining a TTRPG session without an account
- calendar sub-categories

Round 5 covers:
- pass products
- one bill (`dueNow`)
- weekly regulars and owed seats
- the staff Members view
- birthday gifts
- staff game pictures
- random quotes

Round 4 covers:
- member codes
- passes and tabs
- split bills
- POS routes
- soft and locked event holds
- event payment
- spend dice

Round 6 replaced the spend dice with the loyalty card.

The file paths inside the contracts are from the build machine.

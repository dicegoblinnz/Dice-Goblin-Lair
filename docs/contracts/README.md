# Lair API contracts

These are the specs each build round was written against. Read them newest first: where two disagree, the newer one wins.

| File | Round | Date |
|---|---|---|
| `lair-api-contract-v14-discord.md` | Round 14, the Discord bot | 10 Oct 2026 |
| `lair-api-contract-v13-feeds.md` | Round 13, follow a game (the Our games page) | 10 Oct 2026 |
| `lair-api-contract-v12-sim.md` | Round 12, the website simulation's fixes | 10 Oct 2026 |
| `lair-api-contract-v10-memberships.md` | Round 10, library memberships | 9 Oct 2026 |
| `lair-api-contract-v7.md` | Round 7 | 6 Oct 2026 |
| `lair-api-contract-v6.md` | Round 6, part 1 | 5 Oct 2026 |
| `lair-api-contract-v5.md` | Round 5 | 4 Oct 2026 |
| `lair-api-contract-v4.md` | Round 4 | 3 Oct 2026 |
| `lair-api-contract-v3.md` | Round 3 | |
| `lair-api-contract-v1.md` | Base contract | |

Round 14, the Discord bot, covers: slash commands, buttons and pop-ups for TTRPG sessions, events and tables (as a
linked member in one tap, or as a guest); /mylair and cancelling; Link Discord in My Lair (Discord's own sign-in); the
posts in the server with live seat counts, chat threads, seat pings and the midday round-up; /lair-setup; setting it up;
and the clash check fixed on the way.

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

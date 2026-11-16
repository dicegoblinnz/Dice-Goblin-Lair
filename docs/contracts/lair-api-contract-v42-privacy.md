# Lair API contract v42-privacy: the legal check

Round 42 (17 Nov 2026). Mo agreed the legal check's findings ("I agree with all that you are saying. Please push it"):
the shop's privacy policy, terms and library membership rules were rewritten for New Zealand law, and the Lair was brought
in line with what they now promise. No routes change.

The code: `src/lair.js` (`privacyLine`, `longDay`, `confirm`'s `givenBy`, `inviteGm`, `issueOrderPasses`,
`issueGiftPasses`, `sendGiftCodes`, the maintenance run), `src/warhammer.js` (`tellGamePlayers`) and `src/walkins.js`
(`forgetOldClicks`). Tests: `test/round7-b.test.js`, `test/round11-warhammer.test.js`, `test/round40-walkins.test.js` and
`test/lair.test.js`.

## 1. Who gave us your email (the Privacy Act's IPP3A, in force 1 May 2026)

Someone whose email another person typed in is told who, and where the privacy policy is, in the first email they get:

> {who} gave us your email for this {game | seat}. Here's how we look after it: https://www.dicegoblin.nz/policies/privacy-policy

- **A GM without an account, invited by staff** (`inviteGm`): "The Dice Goblin team … for this game".
- **A seat staff or the GM save for someone without an account** (`confirm` from `addPlayer`): "The Dice Goblin team" or
  "GM {name}" "… for this seat". A seat for a customer with an account has no line: their email is their own.
- **A player named in a Warhammer or event game who isn't a member** (`tellGamePlayers`): the booker's first name, "… for
  this game". Members have no line.

## 2. Gift cards and passes show when they end (the Fair Trading Act's gift card rules, in force 16 March 2026)

- An experience gift's email gives the date: "The experience is good until 17 November 2029, even if prices go up." (it
  said "good for 3 years from today").
- A session pass bought online or at the counter, and a session gift, now lasts 3 years from purchase (`PASS_YEARS`; it
  had no expiry). My Lair already shows "Use by {date}" for a pass with one. Passes made before this round keep no
  expiry, and staff-made passes keep whatever staff set.

## 3. Ad clicks are forgotten when they can't count any more

Each maintenance run clears `members.click_gclid` and `click_at` for clicks older than 150 days: the 90 days a click can
lead to a First visit (`WALKIN.clickDays`) plus the 60 a First visit stays on Google's list (`WALKIN.listDays`). The
run's answer counts them as `clicksForgotten`. The privacy policy says ad click IDs are kept for up to 150 days.

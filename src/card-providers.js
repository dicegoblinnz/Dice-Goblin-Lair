/**
 * Round 48 (contract v48-card-pay): who takes the card when a member pays My Lair's bill on their phone. The Lair only
 * ever talks to "a provider"; which one is the CARD_PROVIDER setting (D1 config), so swapping it is a setting and one
 * adapter here, with nothing else touched.
 *
 * A provider is { name, start, look, refund }:
 *  - start({ id, amount, currency, title, back, expiresAt }) → { ref, url }: make a hosted card page for exactly `amount`
 *    (cents) that stops taking payment at `expiresAt` (ms), carrying the Lair's payment id as its reference. `url` is
 *    https and is where the member's phone goes; `back` is the path on the website they return to.
 *  - look(ref) → { status: 'open' | 'paid' | 'failed', amount }: asked server to server. The Lair never believes the
 *    browser about a payment: only this answer, with the amount the provider says it took, pays a bill.
 *    `amount` is whole cents, the same number start was given: a provider that adds a surcharge, or answers in dollars,
 *    must be turned back into that by its adapter, or every payment goes to staff. `currency` may come back too.
 *    'failed' is one try failing; the Lair keeps asking about the page for two hours after it closes, so a second try
 *    on the same page is still found.
 *  - refund(ref, amount, key) → { id }: send it all back, safe to ask twice with the same key.
 *  - cancel(ref) (optional): close a page that's been replaced, so it can't be paid.
 * Give every call its own timeout (15 seconds or so).
 * Each throws when the provider doesn't answer. Keys and merchant ids are Worker secrets, never in this file (the
 * repository is public).
 *
 * No adapter is written yet: Verifone's (eftpos NZ) waits on the answers to Mo's questions of 20 Nov 2026 (hosted
 * checkout through their API in New Zealand, a sandbox, status look-ups and refunds). Until one is here, card pay is
 * off and My Lair doesn't show the button.
 */
const ADAPTERS = {
  // verifone: (env) => verifone(env),
};

/** The provider the settings name, or null when there's none (card pay is off). */
export function cardProvider(env) {
  const make = ADAPTERS[String(env?.CARD_PROVIDER || '').trim().toLowerCase()];
  return make ? make(env) : null;
}

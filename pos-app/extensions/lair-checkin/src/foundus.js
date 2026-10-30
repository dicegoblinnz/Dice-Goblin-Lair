// "How did you find us?" at the counter (contract v24-new-players, section 5). Dice Goblin's ads are judged on what each
// new player costs, so the counter asks a new player how they found the Lair, once, on their first day: one tap, and the
// Lair app keeps the answer for the weekly numbers. No `shopify` global here, so `npm test` can check it without a POS.

/**
 * The answers, in the order the counter shows them, as the Lair app keeps them (src/newplayers.js FOUND_US_ANSWERS:
 * pos-app/test/foundus.test.mjs checks they match).
 * @type {[string, string][]}
 */
export const FOUND_US = [
  ['google', 'Google'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['reddit', 'Reddit'],
  ['friend', 'A friend'], ['walked-past', 'Walked past'], ['discord', 'Discord'], ['other', 'Something else'],
];

/** The question's words on the member view */
export const FOUND_US_WORDS = {
  heading: 'How did they find us?',
  hint: 'They’re new here. Ask, then tap their answer: it tells us which ads bring people in.',
};

/**
 * Whether the member view asks: the Lair app says it's their first day (`newHere`) and nobody has answered yet. A Lair
 * app from before round 24 says neither, so nothing is asked.
 * @param {{ newHere?: unknown, foundUs?: unknown }} screen
 */
export function askFoundUs(screen) {
  return screen?.newHere === true && !screen.foundUs;
}

/** "Saved: Instagram", once an answer is in. @param {string} answer */
export function foundUsSaved(answer) {
  const label = FOUND_US.find(([key]) => key === answer)?.[1];
  return label ? `Saved: ${label}` : 'Saved';
}

// Round 17, Help me pick: the only words a game's facts may use (contract v17 section 1.2), copied word for word from the
// tagging work's vocab.json (16 Oct 2026). The seed, Workers AI's answers and staff edits are all checked against it
// (validFacts in src/pick.js), and the quiz's answers are read with it.
export const PICK_VOCAB = {
  kinds: ['game', 'expansion', 'rpg', 'other'],
  modes: ['competitive', 'coop', 'team', 'solo'],
  vibes: ['chill', 'laughs', 'thinky', 'cutthroat'],
  reading: ['light', 'some', 'heavy'],
  tables: ['single', 'double'],
  confidence: ['high', 'medium', 'low'],
  rpgTypes: ['starter', 'core', 'adventure', 'supplement', 'setting'],
  themes: [
    'fantasy', 'sci-fi', 'space', 'spooky', 'horror', 'mystery', 'crime', 'history', 'war', 'mythology',
    'nature', 'animals', 'cute', 'food', 'pirates', 'adventure', 'city', 'travel', 'trains', 'farming',
    'sports', 'humour', 'superheroes', 'film-tv', 'words', 'abstract', 'science', 'art',
  ],
  styles: [
    'party', 'bluffing', 'hidden-roles', 'deduction', 'negotiation', 'trivia', 'word', 'drawing', 'dexterity',
    'real-time', 'memory', 'push-your-luck', 'dice-rolling', 'roll-and-write', 'set-collection', 'drafting',
    'deck-building', 'engine-building', 'tile-laying', 'pattern-building', 'worker-placement', 'area-control',
    'take-that', 'trick-taking', 'auction', 'route-building', 'racing', 'puzzle', 'abstract', 'storytelling',
    'campaign', 'legacy', 'dungeon-crawl', 'miniatures', 'escape-room', 'one-vs-many', 'economic', 'trading',
    'programming',
  ],
};

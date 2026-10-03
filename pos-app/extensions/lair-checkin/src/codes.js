// Reading the codes staff scan or type: tickets, seats, event sign-ups, member cards and passes all look like
// SJ-OWLBEAR-17 (initials, a word, a number). Older tickets look like GOB-7K2QXM.
// No `shopify` global here, so `npm test` can check it without a POS.

/** The words in codes (API contract v4, appendix). Only used to tidy what staff type; the Lair app does the matching. */
export const CODE_WORDS = [
  'GOBLIN','KOBOLD','OWLBEAR','MIMIC','GOLEM','WYVERN','DRAGON','DRAKE','HYDRA','KRAKEN','GRIFFIN','PHOENIX',
  'UNICORN','PEGASUS','BASILISK','CHIMERA','SPHINX','TROLL','OGRE','GNOME','PIXIE','SPRITE','FAERIE','BROWNIE',
  'IMP','GREMLIN','BUGBEAR','HOBGOBLIN','YETI','GHOST','BANSHEE','WISP','DJINN','GENIE','SELKIE','KELPIE',
  'SATYR','CENTAUR','MINOTAUR','CYCLOPS','HARPY','GORGON','KITSUNE','TANUKI','KAPPA','TENGU','DRYAD','TREANT',
  'WEREWOLF','MUMMY','ZOMBIE','SKELETON','SLIME','OOZE','BLOB',
  'BADGER','OTTER','FERRET','HEDGEHOG','RACCOON','WOMBAT','PLATYPUS','AXOLOTL','NEWT','TOAD','FROG','GECKO',
  'BEETLE','MOTH','SNAIL','CRAB','SQUID','OCTOPUS','NARWHAL','WALRUS','PENGUIN','PUFFIN','RAVEN','MAGPIE',
  'OWL','BAT','FOX','WOLF','BEAR','BOAR','STAG','HARE','LLAMA','ALPACA','CAPYBARA','PANDA','YAK','GOAT',
  'MOOSE','LOBSTER','TORTOISE','TURTLE','LEMUR','SLOTH','KOALA','QUOKKA','MEERKAT','KITTEN','PUPPY',
  'KIWI','KEA','KAKA','TUI','WETA','MOA','TUATARA','KAKAPO','PUKEKO','TAKAHE','KOKAKO','FANTAIL','MOREPORK',
  'RURU','KERERU','WEKA','PAUA','KUMARA','PAVLOVA','JANDAL','LAMINGTON','FEIJOA','PIKELET',
  'MEEPLE','DICE','POTION','SCROLL','WAND','STAFF','SWORD','SHIELD','LANTERN','TORCH','MAP','COMPASS','CROWN',
  'GOBLET','CHEST','RUNE','TOME','AMULET','RING','CLOAK','BOOTS','HELM','AXE','BOW','ARROW','DAGGER','HAMMER',
  'LUTE','HARP','DRUM','QUILL','INKPOT','CANDLE','KEY','ROPE','BACKPACK','CAULDRON','BROOM','MIRROR','ORB',
  'GEM','RUBY','OPAL','AMBER','JADE','PEARL','TOPAZ','GARNET','COIN','DOUBLOON','TREASURE','BANNER','TOKEN',
  'PAWN','ROOK','KNIGHT','BISHOP','QUEEN','KING',
  'PIE','PRETZEL','MUFFIN','SCONE','CRUMPET','PANCAKE','WAFFLE','DUMPLING','NOODLE','PICKLE','TURNIP','RADISH',
  'CARROT','MUSHROOM','TRUFFLE','CHEESE','BISCUIT','COOKIE','TOFFEE','FUDGE','NOUGAT','TOASTIE','NACHO','TACO',
  'BAGEL','DONUT','CUPCAKE','PUDDING','JELLY','CUSTARD',
  'QUEST','SAGA','LEGEND','RIDDLE','SPELL','HEX','CHARM','JINX','OMEN','LOOT','CRIT','BOSS','DUNGEON','TAVERN',
  'CASTLE','TOWER','CAVE','LAIR','PORTAL','MAZE','VAULT','CRYPT','SWAMP','FOREST','MEADOW','GROTTO','ISLAND',
  'VOLCANO','GLACIER',
  'EMBER','SPARK','FROST','THUNDER','STORM','GUST','MIST','SHADOW','STAR','MOON','COMET','NOVA','AURORA',
  'ECLIPSE','RAINBOW','BLIZZARD',
];

const WORDS = new Set(CODE_WORDS);
const FUN = /^([A-Z]{2})([A-Z]{3,12})0*([1-9]\d?)$/; // SJ OWLBEAR 17: two initials, a word, 1–99
const LEGACY = /^GOB([A-Z0-9]{6})$/; // GOB-7K2QXM

/**
 * @typedef {{ kind: 'empty' }
 *   | { kind: 'unknown', text: string }
 *   | { kind: 'code', code: string, key: string, legacy: boolean }} ReadCode
 */

/** Letters and digits only, upper case: the Lair app's lookup key ("sj owlbear 17" → "SJOWLBEAR17"). @param {unknown} raw */
export function codeKey(raw) {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * @param {string} key
 * @param {'word' | 'legacy' | 'any'} how
 * @returns {ReadCode | null}
 */
function match(key, how) {
  const fun = key.match(FUN);
  if (fun && (how === 'any' || (how === 'word' && WORDS.has(fun[2])))) {
    const code = `${fun[1]}-${fun[2]}-${fun[3]}`;
    return { kind: 'code', code, key: codeKey(code), legacy: false };
  }
  const old = key.match(LEGACY);
  if (old && (how === 'any' || how === 'legacy')) return { kind: 'code', code: `GOB-${old[1]}`, key, legacy: true };
  return null;
}

/**
 * Works out what a scanned or typed code is, and tidies it into the printed form. Case, spaces, dashes, dots and
 * underscores don't matter ("sj owlbear 17", "SJOWLBEAR17" and "Sj-Owlbear-17" are all SJ-OWLBEAR-17), and a code
 * inside a longer text or link is still found.
 * @param {unknown} raw
 * @returns {ReadCode}
 */
export function readCode(raw) {
  const text = String(raw ?? '').trim();
  const whole = codeKey(text);
  if (!whole) return { kind: 'empty' };
  const tokens = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Runs of up to 4 neighbouring tokens ("SJ", "OWLBEAR", "17"), last ones first: codes sit at the end of links.
  /** @type {string[]} */
  const runs = [];
  for (let end = tokens.length; end > 0; end -= 1) {
    for (let size = Math.min(4, end); size > 0; size -= 1) runs.push(tokens.slice(end - size, end).join(''));
  }
  // A known word anywhere wins, then an old GOB code, then anything shaped like a code when it's all there is.
  for (const how of /** @type {const} */ (['word', 'legacy'])) {
    for (const candidate of [whole, ...runs]) {
      const found = match(candidate, how);
      if (found) return found;
    }
  }
  return match(whole, 'any') || { kind: 'unknown', text: text.slice(0, 40) };
}

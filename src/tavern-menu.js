// Round 34a, the Tavern: the drinks menu as data, its prices and its recipe cards (contract
// docs/contracts/lair-api-contract-v34-tavern.md, section 1).
//
// One list that the order page, the staff phones, the till and the recipe cards all read, so a price or a recipe is changed
// in one place. It follows the printed menu (the canvas "Tavern drinks menu", 8 Nov 2026). The Lair prices every order
// itself: a page never sends a price the Lair believes.
//
// Mo's rules (8 Nov 2026): creamer, never fresh milk; no green tea; no mini marshmallows; sweetness is with or without
// ("add sweetness"), no levels; hot chocolate is a sachet at $3; make it frozen +$2, Brew Your Own included.
//
// Recipe amounts are drafts (Mo: "You draft, I check", 8 Nov 2026): standard bubble tea doses for a 700 ml cup, which is the
// dose Mo uses in his 600 ml glass mugs with less ice. Scoops are the scoop in each Modoo bag. Until Mo has checked them,
// TAVERN_RECIPES_DRAFT stays true and every recipe card says so.
//
// Pure functions and data only: no Lair, no awaits, so the tests and every page can use them as they are.
import { RuleError } from './core.js';

/** Every recipe card says its amounts are drafts until Mo has checked them */
export const TAVERN_RECIPES_DRAFT = true;

export const TAVERN_TIERS = {
  common: { name: 'Common', price: 800 },
  rare: { name: 'Rare', price: 900 },
  legendary: { name: 'Legendary', price: 1000 },
};

/** The extras that cost something, each its own counter-only Shopify product */
export const TAVERN_EXTRAS = {
  extraTopping: { name: 'Extra topping', price: 100, sku: 'TAVERN-X-TOPPING' },
  oat: { name: 'Oat milk', price: 100, sku: 'TAVERN-X-OAT' },
  frozen: { name: 'Make it frozen', price: 200, sku: 'TAVERN-X-FROZEN' },
};

export const TAVERN_TOPPINGS = [
  { id: 'strawberry-pearls', name: 'Strawberry popping pearls', short: 'strawberry pearls' },
  { id: 'mango-pearls', name: 'Mango popping pearls', short: 'mango pearls' },
  { id: 'blueberry-pearls', name: 'Blueberry popping pearls', short: 'blueberry pearls' },
  { id: 'peach-pearls', name: 'Peach popping pearls', short: 'peach pearls' },
  { id: 'pineapple-pearls', name: 'Pineapple popping pearls', short: 'pineapple pearls' },
  { id: 'passionfruit-pearls', name: 'Passionfruit popping pearls', short: 'passionfruit pearls' },
  { id: 'brown-sugar-jelly', name: 'Brown sugar jelly', short: 'brown sugar jelly' },
  { id: 'coffee-jelly', name: 'Coffee jelly', short: 'coffee jelly', caffeine: true },
];

/** Brew Your Own's flavours: fruit syrups and creamy powders (strawberry and peach come both ways) */
export const TAVERN_FLAVOURS = [
  ...['strawberry', 'raspberry', 'cherry', 'watermelon', 'guava', 'peach', 'grapefruit', 'passionfruit', 'pineapple', 'lychee', 'lemon',
    'green apple', 'kiwifruit', 'grape', 'blueberry', 'yoghurt'].map((name) => ({ id: `fruit-${name.replace(/\s+/g, '-')}`, name, kind: 'fruit' })),
  ...['taro', 'honeydew', 'strawberry', 'peach', 'mango', 'coconut', 'matcha', 'chocolate', 'vanilla', 'Thai tea'].map((name) => ({
    id: `creamy-${name.toLowerCase().replace(/\s+/g, '-')}`, name, kind: 'creamy', caffeine: ['matcha', 'Thai tea'].includes(name),
  })),
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * The menu. kind says how a drink is made (and so which recipe card and options it has): sparkling, creamy (powder and
 * creamer), milktea (a brewed black tea), matcha (layered), shake, slushy, byo (Brew Your Own) or hot. rush: one of the
 * quick drinks the Rush sign keeps on (1–7 and 9).
 */
export const TAVERN_ITEMS = [
  { id: 'strawberry-lemonade', no: 1, name: 'Strawberry Lemonade', fantasy: 'Healing Potion', tier: 'common', kind: 'sparkling', rush: true,
    describe: 'strawberry, lemon, sparkling', topping: 'strawberry-pearls',
    make: { syrups: [['Strawberry syrup', 25], ['Lemon syrup', 15]] } },
  { id: 'blue-lychee', no: 2, name: 'Blue Lychee', fantasy: 'Mana Potion', tier: 'common', kind: 'sparkling', rush: true,
    describe: 'lychee, blue citrus, sparkling', topping: 'pineapple-pearls',
    make: { syrups: [['Lychee syrup', 30], ['Blue curaçao syrup', 10]] } },
  { id: 'passionfruit-mango', no: 3, name: 'Passionfruit Mango', fantasy: 'Sunfire Elixir', tier: 'common', kind: 'sparkling', rush: true,
    describe: 'passionfruit, sparkling', topping: 'mango-pearls',
    make: { syrups: [['Passionfruit syrup', 40]] } },
  { id: 'peach-grapefruit', no: 4, name: 'Peach Grapefruit', fantasy: 'Dawn Nectar', tier: 'common', kind: 'sparkling', rush: true,
    describe: 'peach, grapefruit, sparkling', topping: 'peach-pearls',
    make: { syrups: [['Peach syrup', 20], ['Grapefruit syrup', 20]] } },
  { id: 'taro-milk', no: 5, name: 'Taro Milk', fantasy: 'Twilight Tonic', tier: 'rare', kind: 'creamy', rush: true,
    describe: 'taro, creamer', topping: 'brown-sugar-jelly',
    make: { powders: [['Taro powder', 4]] } },
  { id: 'strawberry-milk', no: 6, name: 'Strawberry Milk', fantasy: 'Charm Potion', tier: 'rare', kind: 'creamy', rush: true,
    describe: 'strawberry, creamer', topping: 'strawberry-pearls',
    make: { powders: [['Strawberry powder', 4]] } },
  { id: 'honeydew-milk', no: 7, name: 'Honeydew Milk', fantasy: "Dryad's Dew", tier: 'rare', kind: 'creamy', rush: true,
    describe: 'honeydew, creamer', topping: 'mango-pearls',
    make: { powders: [['Honeydew powder', 4]] } },
  { id: 'brown-sugar-milk-tea', no: 8, name: 'Brown Sugar Milk Tea', fantasy: 'Dwarven Brew', tier: 'rare', kind: 'milktea', caffeine: true,
    describe: 'black tea, brown sugar, creamer', topping: 'brown-sugar-jelly', make: {} },
  { id: 'thai-milk-tea', no: 9, name: 'Thai Milk Tea', fantasy: "Dragon's Ember", tier: 'rare', kind: 'creamy', caffeine: true, rush: true,
    describe: 'Thai tea, creamer', topping: 'brown-sugar-jelly',
    make: { powders: [['Thai tea powder', 4]] } },
  { id: 'strawberry-matcha', no: 10, name: 'Strawberry Matcha', fantasy: "Druid's Bloom", tier: 'rare', kind: 'matcha', caffeine: true,
    describe: 'strawberry, creamer, matcha', topping: 'strawberry-pearls', make: {} },
  { id: 'cookies-cream-shake', no: 11, name: 'Cookies & Cream Shake', fantasy: "Frost Giant's Feast", tier: 'legendary', kind: 'shake',
    describe: 'made with our own ice cream', topping: null, make: {} },
  { id: 'mango-slushy', no: 12, name: 'Mango Slushy', fantasy: 'Glacier Sun', tier: 'legendary', kind: 'slushy',
    describe: 'mango, blended with ice', topping: 'mango-pearls', make: {} },
  { id: 'brew-your-own', name: 'Brew Your Own', fantasy: "Alchemist's Choice", price: 1000, kind: 'byo', sku: 'TAVERN-BYO',
    describe: 'a base, up to two flavours and a topping', topping: null },
  { id: 'coffee', name: 'Coffee', price: 300, kind: 'hot', sku: 'TAVERN-COFFEE', caffeine: true, describe: 'a sachet, made with hot water',
    choices: ['Latte', 'Caramel latte', 'Cappuccino', 'Strong cappuccino', 'Double shot latte'], sugarFree: ['Caramel latte', 'Cappuccino'] },
  { id: 'hot-chocolate', name: 'Hot Chocolate', price: 300, kind: 'hot', sku: 'TAVERN-HOTCHOC', describe: 'a sachet, made with hot water' },
  { id: 'tea', name: 'Tea', price: 200, kind: 'hot', sku: 'TAVERN-TEA', describe: 'one bag, brewed in the mug',
    choices: ['English breakfast', 'Decaf black tea', 'Peppermint', 'Camomile', 'Lemon & ginger'], caffeineChoices: ['English breakfast'] },
  { id: 'pukka', name: 'Pukka Tea', price: 300, kind: 'hot', sku: 'TAVERN-PUKKA', describe: 'one bag, brewed in the mug',
    choices: ['Three mint', 'Three ginger', 'Vanilla chai', 'Lemon, ginger & manuka honey'] },
].map((item) => ({
  ...item,
  sku: item.sku || `TAVERN-${pad(item.no)}`,
  price: item.price ?? TAVERN_TIERS[item.tier].price,
  caffeine: Boolean(item.caffeine),
  rush: Boolean(item.rush),
}));

const ITEM = new Map(TAVERN_ITEMS.map((x) => [x.id, x]));
const TOPPING = new Map(TAVERN_TOPPINGS.map((x) => [x.id, x]));
const FLAVOUR = new Map(TAVERN_FLAVOURS.map((x) => [x.id, x]));

/** The most drinks one order holds */
export const TAVERN_MAX_LINES = 12;
/** A note for whoever makes it ("no straw"), up to this many characters */
export const TAVERN_NOTE_MAX = 60;

const COLD = ['sparkling', 'creamy', 'milktea', 'matcha', 'shake', 'slushy', 'byo'];
const FREEZABLE = ['sparkling', 'creamy', 'milktea', 'matcha', 'byo'];
const CREAMY_KINDS = ['creamy', 'milktea', 'matcha', 'shake'];

/** The Tavern's words, for members and staff: plain NZ English */
export const TAVERN_MENU_WORDS = {
  noLines: 'Pick a drink first.',
  tooMany: `One order holds up to ${TAVERN_MAX_LINES} drinks. Order these, then the rest.`,
  unknown: "Gobgob doesn't know that drink. Pick it from the menu again.",
  topping: "That topping isn't on the menu. Pick another one.",
  ice: 'Pick normal ice, less ice or no ice.',
  noOat: 'Oat milk goes in the creamy drinks only.',
  noFrozen: "That one's blended already, so it can't be made frozen.",
  noIce: "That one's blended, so its ice can't change.",
  choice: (name) => `Pick which ${name.toLowerCase()} you'd like.`,
  sugarFree: "That one doesn't come sugar free.",
  base: 'Pick a base: sparkling or creamer.',
  flavours: 'Pick one or two flavours.',
  flavour: "That flavour isn't on the menu. Pick another one.",
  sparklingFruit: 'Sparkling goes with the fruit flavours only.',
  note: `Keep the note to ${TAVERN_NOTE_MAX} letters.`,
  rush: "That one's resting during the rush. Pick one of the quick drinks.",
};

const yes = (v) => v === true || v === 'true' || v === 1;

/** A drink as the order page and staff phones list it (no recipe) */
function itemView(x) {
  return {
    id: x.id, no: x.no ?? null, name: x.name, fantasy: x.fantasy || null, kind: x.kind, tier: x.tier || null, price: x.price,
    describe: x.describe, topping: x.topping || null, caffeine: x.caffeine, rush: x.rush,
    choices: x.choices || null, sugarFree: x.sugarFree || null, caffeineChoices: x.caffeineChoices || null,
    options: {
      topping: COLD.includes(x.kind), ice: COLD.includes(x.kind) && !['shake', 'slushy'].includes(x.kind), sweet: COLD.includes(x.kind),
      takeaway: COLD.includes(x.kind), extraTopping: COLD.includes(x.kind), oat: CREAMY_KINDS.includes(x.kind) || x.kind === 'byo',
      frozen: FREEZABLE.includes(x.kind),
    },
  };
}

/** The whole menu as pages show it: { tiers, items, toppings, flavours, extras, draft } (no recipes) */
export function tavernMenuView() {
  return {
    tiers: TAVERN_TIERS,
    items: TAVERN_ITEMS.map(itemView),
    toppings: TAVERN_TOPPINGS.map(({ id, name, short, caffeine }) => ({ id, name, short, caffeine: Boolean(caffeine) })),
    flavours: TAVERN_FLAVOURS.map(({ id, name, kind, caffeine }) => ({ id, name, kind, caffeine: Boolean(caffeine) })),
    extras: Object.fromEntries(Object.entries(TAVERN_EXTRAS).map(([k, v]) => [k, { name: v.name, price: v.price }])),
  };
}

/** A drink by its id, or null */
export const tavernItem = (id) => ITEM.get(String(id ?? '')) || null;

function toppingOf(id) {
  if (id === null || id === undefined || id === '') return null;
  const t = TOPPING.get(String(id));
  if (!t) throw new RuleError(TAVERN_MENU_WORDS.topping);
  return t.id;
}

/**
 * One line from a page ({ item, options }), checked against the menu and priced: { item, no, name, fantasy, kind,
 * options, words, price, parts: [{ sku, title, price }], caffeine }. Throws a RuleError for anything the menu doesn't
 * allow. rush: only the quick drinks (and hot drinks, which need no blender or shaker).
 */
export function tavernLine(raw, { rush = false } = {}) {
  const item = tavernItem(raw?.item);
  if (!item) throw new RuleError(TAVERN_MENU_WORDS.unknown);
  if (rush && !item.rush && item.kind !== 'hot') throw new RuleError(TAVERN_MENU_WORDS.rush);
  const o = raw?.options && typeof raw.options === 'object' ? raw.options : {};
  const note = String(o.note ?? '').trim().replace(/\s+/g, ' ');
  if (note.length > TAVERN_NOTE_MAX) throw new RuleError(TAVERN_MENU_WORDS.note);
  const options = {};
  const words = [];
  let caffeine = item.caffeine;

  if (item.kind === 'hot') {
    if (item.choices) {
      const choice = item.choices.find((c) => c === o.choice);
      if (!choice) throw new RuleError(TAVERN_MENU_WORDS.choice(item.name));
      options.choice = choice;
      words.push(choice);
      if (item.caffeineChoices) caffeine = item.caffeineChoices.includes(choice);
    }
    if (yes(o.sugarFree)) {
      if (!item.sugarFree?.includes(options.choice)) throw new RuleError(TAVERN_MENU_WORDS.sugarFree);
      options.sugarFree = true;
      words.push('99% sugar free');
    }
  } else {
    if (item.kind === 'byo') {
      const base = ['sparkling', 'creamer'].find((b) => b === o.base);
      if (!base) throw new RuleError(TAVERN_MENU_WORDS.base);
      const list = Array.isArray(o.flavours) ? [...new Set(o.flavours.map(String))] : [];
      if (list.length < 1 || list.length > 2) throw new RuleError(TAVERN_MENU_WORDS.flavours);
      const flavours = list.map((id) => {
        const f = FLAVOUR.get(id);
        if (!f) throw new RuleError(TAVERN_MENU_WORDS.flavour);
        return f;
      });
      if (base === 'sparkling' && flavours.some((f) => f.kind !== 'fruit')) throw new RuleError(TAVERN_MENU_WORDS.sparklingFruit);
      options.base = base;
      options.flavours = flavours.map((f) => f.id);
      words.push(`${flavours.map((f) => f.name).join(' + ')}, ${base}`);
      if (flavours.some((f) => f.caffeine)) caffeine = true;
    }
    // the topping: the drink's own unless they picked another (the shake has none until they pick one)
    const topping = 'topping' in o ? toppingOf(o.topping) : item.topping || null;
    if (item.kind === 'byo' && !topping) throw new RuleError(TAVERN_MENU_WORDS.topping);
    options.topping = topping;
    if (topping) words.push(TOPPING.get(topping).short);
    if (topping && TOPPING.get(topping).caffeine) caffeine = true;
    const extra = 'extraTopping' in o ? toppingOf(o.extraTopping) : null;
    if (extra) {
      options.extraTopping = extra;
      words.push(`extra ${TOPPING.get(extra).short}`);
      if (TOPPING.get(extra).caffeine) caffeine = true;
    }
    const ice = o.ice === undefined || o.ice === null || o.ice === '' ? 'normal' : String(o.ice);
    if (!['normal', 'less', 'none'].includes(ice)) throw new RuleError(TAVERN_MENU_WORDS.ice);
    if (['shake', 'slushy'].includes(item.kind) && ice !== 'normal') throw new RuleError(TAVERN_MENU_WORDS.noIce);
    const frozen = yes(o.frozen);
    if (frozen && !FREEZABLE.includes(item.kind)) throw new RuleError(TAVERN_MENU_WORDS.noFrozen);
    if (frozen && ice !== 'normal') throw new RuleError(TAVERN_MENU_WORDS.noIce);
    options.ice = ice;
    if (ice === 'less') words.push('less ice');
    if (ice === 'none') words.push('no ice');
    if (frozen) {
      options.frozen = true;
      words.push('frozen');
    }
    const oat = yes(o.oat);
    if (oat && !(CREAMY_KINDS.includes(item.kind) || (item.kind === 'byo' && options.base === 'creamer'))) throw new RuleError(TAVERN_MENU_WORDS.noOat);
    if (oat) {
      options.oat = true;
      words.push('oat milk');
    }
    if (yes(o.sweet)) {
      options.sweet = true;
      words.push('add sweetness');
    }
    if (yes(o.takeaway)) {
      options.takeaway = true;
      words.push('takeaway cup');
    }
  }
  if (note) options.note = note;

  const parts = [{ sku: item.sku, title: item.name, price: item.price }];
  if (options.extraTopping) parts.push({ sku: TAVERN_EXTRAS.extraTopping.sku, title: TAVERN_EXTRAS.extraTopping.name, price: TAVERN_EXTRAS.extraTopping.price });
  if (options.oat) parts.push({ sku: TAVERN_EXTRAS.oat.sku, title: TAVERN_EXTRAS.oat.name, price: TAVERN_EXTRAS.oat.price });
  if (options.frozen) parts.push({ sku: TAVERN_EXTRAS.frozen.sku, title: TAVERN_EXTRAS.frozen.name, price: TAVERN_EXTRAS.frozen.price });
  const price = parts.reduce((sum, p) => sum + p.price, 0);
  const first = words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : '';
  return {
    item: item.id, no: item.no ?? null, name: item.name, fantasy: item.fantasy || null, kind: item.kind, options,
    words: [first, ...words.slice(1)].filter(Boolean).join(' · '), price, parts, caffeine,
  };
}

/** A whole order's lines, checked and priced: { lines, total }. Throws a RuleError (the first problem) otherwise. */
export function tavernPrice(rawLines, { rush = false } = {}) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw new RuleError(TAVERN_MENU_WORDS.noLines);
  if (rawLines.length > TAVERN_MAX_LINES) throw new RuleError(TAVERN_MENU_WORDS.tooMany);
  const lines = rawLines.map((raw) => tavernLine(raw, { rush }));
  return { lines, total: lines.reduce((sum, l) => sum + l.price, 0) };
}

/** Every SKU the menu needs in Shopify (each a counter-only product): [{ sku, title, price }] */
export function tavernSkus() {
  return [
    ...TAVERN_ITEMS.map((x) => ({ sku: x.sku, title: x.name, price: x.price })),
    ...Object.values(TAVERN_EXTRAS).map((x) => ({ sku: x.sku, title: x.name, price: x.price })),
  ];
}

/* ---------------- recipe cards ---------------- */

const TOPPING_SCOOPS = '1½ scoops';
const iceWords = { normal: '1 scoop', less: '½ scoop', none: 'none' };

/** Topping lines: the drink's topping and any extra one */
function toppingIngredients(o) {
  const out = [];
  if (o.topping) out.push({ what: TOPPING.get(o.topping).name, amount: TOPPING_SCOOPS });
  if (o.extraTopping) out.push({ what: `${TOPPING.get(o.extraTopping).name} (extra)`, amount: TOPPING_SCOOPS });
  return out;
}

function toppingStep(o) {
  const names = [o.topping, o.extraTopping].filter(Boolean).map((id) => TOPPING.get(id).short);
  return names.length ? `${names.join(' and ').replace(/^./, (c) => c.toUpperCase())} in the mug first (${TOPPING_SCOOPS} each).` : null;
}

function sweetness(o, ingredients, steps, when) {
  if (!o.sweet) return;
  ingredients.push({ what: 'Sugar syrup (add sweetness)', amount: '15 ml' });
  steps.push(`15 ml sugar syrup ${when}.`);
}

/** Syrups for Brew Your Own's fruit flavours: 40 ml for one, 20 ml each for two */
const byoSyrups = (flavours) => flavours.filter((f) => f.kind === 'fruit').map((f, _, all) => [`${f.name.replace(/^./, (c) => c.toUpperCase())} syrup`, all.length > 1 ? 20 : 40]);
/** Powders for its creamy flavours: 4 scoops for one, 2 each for two */
const byoPowders = (flavours) => flavours.filter((f) => f.kind === 'creamy').map((f, _, all) => [`${f.name.replace(/^./, (c) => c.toUpperCase())} powder`, all.length > 1 ? 2 : 4]);

function sparklingCard(o, syrups) {
  const ingredients = [...toppingIngredients(o), ...syrups.map(([what, ml]) => ({ what, amount: `${ml} ml` }))];
  const steps = [toppingStep(o)];
  if (o.frozen) {
    ingredients.push({ what: 'Water (never soda water in the blender)', amount: '150 ml' }, { what: 'Ice', amount: '2 scoops' });
    steps.push(`${syrups.map(([what, ml]) => `${what} ${ml} ml`).join(', ')}, 150 ml water and 2 scoops of ice into the blender.`);
    sweetness(o, ingredients, steps, 'into the blender too');
    steps.push('Blend for 30 seconds, until smooth.', 'Pour over the topping. Big straw in.');
  } else {
    ingredients.push({ what: 'Ice', amount: iceWords[o.ice] }, { what: 'Soda water', amount: 'to 1 cm below the rim (about 300 ml)' });
    steps.push(`${syrups.map(([what, ml]) => `${what} ${ml} ml`).join(', ')} into the mug.`);
    sweetness(o, ingredients, steps, 'in too');
    steps.push(o.ice === 'none' ? 'No ice: a little more soda water instead.' : `Ice: ${iceWords[o.ice]}.`);
    steps.push('Soda water slowly, to 1 cm below the rim.', 'Stir gently twice, so it keeps its fizz. Straw in.');
  }
  return { ingredients, steps };
}

function creamyCard(o, powders, syrups = []) {
  const ingredients = [...toppingIngredients(o)];
  for (const [what, scoops] of powders) ingredients.push({ what, amount: `${scoops} scoops` });
  for (const [what, ml] of syrups) ingredients.push({ what, amount: `${ml} ml` });
  const steps = [toppingStep(o)];
  const flavour = [...powders.map(([w, s]) => `${w} ${s} scoops`), ...syrups.map(([w, ml]) => `${w} ${ml} ml`)].join(', ');
  if (o.oat) {
    ingredients.push({ what: 'Hot water', amount: '80 ml' }, { what: 'Oat milk (instead of creamer)', amount: '150 ml' });
    steps.push(`${flavour} into the shaker with 80 ml hot water. Stir until there are no lumps.`, 'Add 150 ml oat milk (no creamer).');
  } else {
    ingredients.push({ what: 'Creamer', amount: '3 scoops' }, { what: 'Hot water', amount: '100 ml' }, { what: 'Cold water', amount: '150 ml' });
    steps.push(`${flavour} and 3 scoops of creamer into the shaker with 100 ml hot water. Stir until there are no lumps.`, 'Add 150 ml cold water.');
  }
  sweetness(o, ingredients, steps, 'in too');
  if (o.frozen) {
    ingredients.push({ what: 'Ice', amount: '2 scoops' });
    steps.push('Into the blender with 2 scoops of ice. Blend for 30 seconds.', 'Pour over the topping. Big straw in.');
  } else {
    ingredients.push({ what: 'Ice', amount: iceWords[o.ice] });
    steps.push(o.ice === 'none' ? 'No ice: shake it for 10 seconds anyway, it froths.' : `Ice in the shaker (${iceWords[o.ice]}), lid on, shake hard for 10 seconds.`);
    steps.push('Pour over the topping. Straw in.');
  }
  return { ingredients, steps };
}

function milkTeaCard(o) {
  const ingredients = [
    ...toppingIngredients(o),
    { what: 'Brown sugar syrup', amount: '20 ml' },
    { what: 'Black tea bag (decaf if they ask)', amount: '1' },
    { what: 'Hot water', amount: '150 ml' },
  ];
  const steps = [toppingStep(o), 'Swirl 20 ml brown sugar syrup round the inside of the mug.', 'Black tea bag in 150 ml hot water for 4 minutes, then the bag out.'];
  if (o.oat) {
    ingredients.push({ what: 'Oat milk (instead of creamer)', amount: '120 ml' });
    steps.push('Add 120 ml oat milk (no creamer).');
  } else {
    ingredients.push({ what: 'Creamer', amount: '3 scoops' }, { what: 'Cold water', amount: '100 ml' });
    steps.push('Stir 3 scoops of creamer into the tea, then add 100 ml cold water.');
  }
  sweetness(o, ingredients, steps, 'in too');
  if (o.frozen) {
    ingredients.push({ what: 'Ice', amount: '2 scoops' });
    steps.push('Into the blender with 2 scoops of ice. Blend for 30 seconds.', 'Pour in slowly so the syrup streaks. Big straw in.');
  } else {
    ingredients.push({ what: 'Ice', amount: iceWords[o.ice] });
    steps.push(o.ice === 'none' ? 'No ice: shake for 10 seconds anyway.' : `Ice in the shaker (${iceWords[o.ice]}), shake hard for 10 seconds.`);
    steps.push('Pour in slowly so the syrup streaks. Straw in.');
  }
  return { ingredients, steps };
}

function matchaCard(o) {
  const ingredients = [...toppingIngredients(o), { what: 'Strawberry syrup', amount: '25 ml' }];
  const steps = [toppingStep(o), '25 ml strawberry syrup over the pearls.'];
  if (o.oat) {
    ingredients.push({ what: 'Oat milk (instead of creamer)', amount: '180 ml' });
    steps.push('180 ml oat milk ready in a jug (no creamer).');
  } else {
    ingredients.push({ what: 'Creamer', amount: '3 scoops' }, { what: 'Hot water', amount: '50 ml' }, { what: 'Cold water', amount: '150 ml' });
    steps.push('3 scoops of creamer stirred into 50 ml hot water, then 150 ml cold water.');
  }
  sweetness(o, ingredients, steps, 'into the milk');
  if (o.frozen) {
    ingredients.push({ what: 'Ice', amount: '2 scoops' });
    steps.push('Blend the milk with 2 scoops of ice for 30 seconds and pour it over the syrup.');
  } else {
    ingredients.push({ what: 'Ice', amount: iceWords[o.ice] });
    steps.push(o.ice === 'none' ? 'No ice: pour the milk straight over the syrup.' : `Ice in the mug (${iceWords[o.ice]}), then the milk.`);
  }
  ingredients.push({ what: 'Matcha powder', amount: '1 scoop' }, { what: 'Hot water (for the matcha)', amount: '50 ml' });
  steps.push('1 scoop of matcha whisked into 50 ml hot water until there are no lumps.', 'Pour the matcha slowly over the top so it sits in a layer. Straw in.');
  return { ingredients, steps };
}

function shakeCard(o) {
  const milk = o.oat ? ['Oat milk (instead of milk)', '200 ml'] : ['Milk', '200 ml'];
  const ingredients = [...toppingIngredients(o), { what: 'Our cookies & cream ice cream', amount: '2 big scoops (about 200 g)' }, { what: milk[0], amount: milk[1] }];
  const steps = [toppingStep(o), `2 big scoops of our cookies & cream ice cream and ${milk[1]} ${o.oat ? 'oat milk' : 'milk'} into the blender.`];
  sweetness(o, ingredients, steps, 'into the blender too');
  steps.push('Blend for 20 seconds, until thick and smooth.', 'Pour. Big straw in.');
  return { ingredients, steps };
}

function slushyCard(o) {
  const ingredients = [...toppingIngredients(o), { what: 'Mango powder', amount: '4 scoops' }, { what: 'Water', amount: '150 ml' }, { what: 'Ice', amount: '2 scoops' }];
  const steps = [toppingStep(o), '4 scoops of mango powder, 150 ml water and 2 scoops of ice into the blender.'];
  sweetness(o, ingredients, steps, 'into the blender too');
  steps.push('Blend for 30 seconds, until smooth.', 'Pour over the topping. Big straw in.');
  return { ingredients, steps };
}

function hotCard(item, o) {
  if (item.id === 'coffee' || item.id === 'hot-chocolate') {
    const sachet = item.id === 'coffee' ? `${o.choice}${o.sugarFree ? ' (99% sugar free)' : ''} sachet` : 'Hot chocolate sachet';
    return {
      ingredients: [{ what: sachet, amount: '1' }, { what: 'Hot water', amount: '200 ml' }],
      steps: [`${sachet} into a hot mug.`, '200 ml hot water, then stir well.', 'Milk and sugar on the side if they ask.'],
    };
  }
  const bag = item.id === 'pukka' ? `Pukka ${o.choice} tea bag` : `${o.choice} tea bag`;
  const minutes = item.id === 'pukka' || (item.id === 'tea' && !['English breakfast', 'Decaf black tea'].includes(o.choice)) ? '5 minutes' : '3 to 4 minutes';
  return {
    ingredients: [{ what: bag, amount: '1' }, { what: 'Hot water', amount: '250 ml' }],
    steps: [`${bag} into a hot mug.`, '250 ml hot water.', `Brew for ${minutes}. Ask if they'd like the bag left in.`, 'Milk and sugar on the side if they ask.'],
  };
}

/**
 * The recipe card for one priced line (tavernLine's answer): { title, cup, ingredients: [{ what, amount }], steps,
 * note, draft }, worked out for the drink as it was ordered.
 */
export function tavernRecipe(line) {
  const item = tavernItem(line?.item);
  if (!item) throw new RuleError(TAVERN_MENU_WORDS.unknown);
  const o = line.options || {};
  let card;
  if (item.kind === 'hot') card = hotCard(item, o);
  else if (item.kind === 'sparkling') card = sparklingCard(o, item.make.syrups);
  else if (item.kind === 'creamy') card = creamyCard(o, item.make.powders);
  else if (item.kind === 'milktea') card = milkTeaCard(o);
  else if (item.kind === 'matcha') card = matchaCard(o);
  else if (item.kind === 'shake') card = shakeCard(o);
  else if (item.kind === 'slushy') card = slushyCard(o);
  else {
    const flavours = (o.flavours || []).map((id) => FLAVOUR.get(id)).filter(Boolean);
    card = o.base === 'sparkling' ? sparklingCard(o, byoSyrups(flavours)) : creamyCard(o, byoPowders(flavours), byoSyrups(flavours));
  }
  const cup = item.kind === 'hot' ? 'Hot mug' : o.takeaway ? 'Takeaway cup (seal it)' : 'Glass tavern mug';
  return {
    title: item.kind === 'byo' ? `Brew Your Own: ${line.words || ''}`.trim() : item.name,
    cup,
    ingredients: card.ingredients,
    steps: card.steps.filter(Boolean),
    note: o.note || null,
    draft: TAVERN_RECIPES_DRAFT,
  };
}

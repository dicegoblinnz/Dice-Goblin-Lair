// Round 34a: the Tavern menu, its prices and its recipe cards (contract v34-tavern, section 1). Mo (8 Nov 2026): creamer
// not fresh milk, no green tea, no mini marshmallows, sweetness with or without, hot chocolate a $3 sachet, frozen +$2.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAVERN_ITEMS, TAVERN_MAX_LINES, TAVERN_MENU_WORDS as W, TAVERN_RECIPES_DRAFT, tavernLine, tavernMenuView, tavernPrice, tavernRecipe, tavernSkus,
} from '../src/tavern-menu.js';

const line = (item, options = {}, opts) => tavernLine({ item, options }, opts);
const refuses = (fn, words) => assert.throws(fn, (e) => e.message === words);

test('the menu: twelve numbered drinks at $8, $9 and $10, Brew Your Own $10 and the hot drinks', () => {
  const numbered = TAVERN_ITEMS.filter((x) => x.no);
  assert.deepEqual(numbered.map((x) => x.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(numbered.map((x) => x.price), [800, 800, 800, 800, 900, 900, 900, 900, 900, 900, 1000, 1000]);
  const price = (id) => TAVERN_ITEMS.find((x) => x.id === id).price;
  assert.equal(price('brew-your-own'), 1000);
  assert.equal(price('coffee'), 300);
  assert.equal(price('hot-chocolate'), 300);
  assert.equal(price('tea'), 200);
  assert.equal(price('pukka'), 300);
  // the Rush sign's quick drinks: 1 to 7 and 9
  assert.deepEqual(numbered.filter((x) => x.rush).map((x) => x.no), [1, 2, 3, 4, 5, 6, 7, 9]);
  const skus = tavernSkus().map((x) => x.sku);
  assert.equal(new Set(skus).size, skus.length);
  assert.ok(skus.every((s) => /^TAVERN-[A-Z0-9-]+$/.test(s)));
});

test("Mo's rules hold everywhere: creamer not fresh milk, no green tea, no mini marshmallows", () => {
  const cards = [];
  for (const item of TAVERN_ITEMS) {
    const options = item.kind === 'byo' ? { base: 'creamer', flavours: ['creamy-taro'], topping: 'mango-pearls' } : item.choices ? { choice: item.choices[0] } : {};
    cards.push(tavernRecipe(line(item.id, options)));
  }
  const all = JSON.stringify({ menu: tavernMenuView(), cards }).toLowerCase();
  assert.ok(!all.includes('fresh milk'));
  assert.ok(!all.includes('green tea'));
  assert.ok(!all.includes('pure green') && !all.includes('lemon green') && !all.includes('supreme matcha'));
  assert.ok(!all.includes('mallow'));
  assert.ok(all.includes('creamer'));
});

test('a drink is priced by the Lair: its tier, plus extra topping $1, oat milk $1 and frozen $2', () => {
  const plain = line('strawberry-lemonade', { price: 1 });
  assert.equal(plain.price, 800);
  assert.equal(plain.options.topping, 'strawberry-pearls');
  assert.equal(plain.options.ice, 'normal');
  assert.deepEqual(plain.parts.map((p) => p.sku), ['TAVERN-01']);
  const loaded = line('taro-milk', { extraTopping: 'coffee-jelly', oat: true, frozen: true, sweet: true, takeaway: true });
  assert.equal(loaded.price, 900 + 100 + 100 + 200);
  assert.deepEqual(loaded.parts.map((p) => p.sku), ['TAVERN-05', 'TAVERN-X-TOPPING', 'TAVERN-X-OAT', 'TAVERN-X-FROZEN']);
  assert.equal(loaded.caffeine, true, 'coffee jelly has caffeine');
  assert.match(loaded.words, /^Brown sugar jelly · extra coffee jelly · frozen · oat milk · add sweetness · takeaway cup$/);
  assert.equal(line('passionfruit-mango', { topping: 'peach-pearls', ice: 'less' }).words, 'Peach pearls · less ice');
});

test("the menu's limits: oat milk in creamy drinks only, nothing frozen that's blended already, ice and toppings from the list", () => {
  refuses(() => line('blue-lychee', { oat: true }), W.noOat);
  refuses(() => line('cookies-cream-shake', { frozen: true }), W.noFrozen);
  refuses(() => line('mango-slushy', { frozen: true }), W.noFrozen);
  refuses(() => line('mango-slushy', { ice: 'less' }), W.noIce);
  refuses(() => line('taro-milk', { frozen: true, ice: 'none' }), W.noIce);
  refuses(() => line('taro-milk', { ice: 'loads' }), W.ice);
  refuses(() => line('taro-milk', { topping: 'mini-marshmallows' }), W.topping);
  refuses(() => line('taro-milk', { note: 'x'.repeat(61) }), W.note);
  refuses(() => line('not-a-drink'), W.unknown);
  // the shake takes oat milk (in place of the milk) and a topping only when they pick one
  assert.equal(line('cookies-cream-shake', { oat: true }).price, 1100);
  assert.equal(line('cookies-cream-shake').options.topping, null);
});

test('Brew Your Own: a base, one or two flavours (sparkling takes fruit only) and a topping; frozen makes it $12', () => {
  const byo = line('brew-your-own', { base: 'sparkling', flavours: ['fruit-cherry', 'fruit-lemon'], topping: 'strawberry-pearls' });
  assert.equal(byo.price, 1000);
  assert.equal(byo.words, 'Cherry + lemon, sparkling · strawberry pearls');
  assert.equal(line('brew-your-own', { base: 'creamer', flavours: ['creamy-mango'], topping: 'mango-pearls', frozen: true }).price, 1200);
  refuses(() => line('brew-your-own', { base: 'water', flavours: ['fruit-cherry'], topping: 'mango-pearls' }), W.base);
  refuses(() => line('brew-your-own', { base: 'sparkling', flavours: [], topping: 'mango-pearls' }), W.flavours);
  refuses(() => line('brew-your-own', { base: 'sparkling', flavours: ['fruit-cherry', 'fruit-lemon', 'fruit-grape'], topping: 'mango-pearls' }), W.flavours);
  refuses(() => line('brew-your-own', { base: 'sparkling', flavours: ['creamy-taro'], topping: 'mango-pearls' }), W.sparklingFruit);
  refuses(() => line('brew-your-own', { base: 'creamer', flavours: ['fruit-durian'], topping: 'mango-pearls' }), W.flavour);
  refuses(() => line('brew-your-own', { base: 'creamer', flavours: ['creamy-taro'] }), W.topping);
  refuses(() => line('brew-your-own', { base: 'sparkling', flavours: ['fruit-cherry'], topping: 'mango-pearls', oat: true }), W.noOat);
  assert.equal(line('brew-your-own', { base: 'creamer', flavours: ['creamy-matcha'], topping: 'mango-pearls' }).caffeine, true);
});

test('hot drinks: pick which one; only cappuccino and caramel latte come 99% sugar free; tea has caffeine only when it does', () => {
  refuses(() => line('coffee'), W.choice('Coffee'));
  refuses(() => line('coffee', { choice: 'Flat white' }), W.choice('Coffee'));
  assert.equal(line('coffee', { choice: 'Cappuccino', sugarFree: true }).words, 'Cappuccino · 99% sugar free');
  refuses(() => line('coffee', { choice: 'Latte', sugarFree: true }), W.sugarFree);
  assert.equal(line('hot-chocolate').price, 300);
  assert.equal(line('tea', { choice: 'English breakfast' }).caffeine, true);
  assert.equal(line('tea', { choice: 'Peppermint' }).caffeine, false);
  assert.equal(line('pukka', { choice: 'Vanilla chai' }).price, 300);
});

test('the rush: only the quick drinks (and hot drinks) can be ordered while the Rush sign is out', () => {
  assert.equal(line('thai-milk-tea', {}, { rush: true }).price, 900);
  refuses(() => line('brown-sugar-milk-tea', {}, { rush: true }), W.rush);
  refuses(() => line('mango-slushy', {}, { rush: true }), W.rush);
  assert.equal(line('hot-chocolate', {}, { rush: true }).price, 300);
});

test('an order: one to twelve drinks, and its total', () => {
  refuses(() => tavernPrice([]), W.noLines);
  refuses(() => tavernPrice(Array.from({ length: TAVERN_MAX_LINES + 1 }, () => ({ item: 'tea', options: { choice: 'Camomile' } }))), W.tooMany);
  const { lines, total } = tavernPrice([{ item: 'mango-slushy' }, { item: 'blue-lychee', options: { frozen: true } }, { item: 'tea', options: { choice: 'Camomile' } }]);
  assert.equal(lines.length, 3);
  assert.equal(total, 1000 + 1000 + 200);
});

test('recipe cards are worked out for the drink as ordered, and say they are drafts until Mo checks them', () => {
  assert.equal(TAVERN_RECIPES_DRAFT, true);
  const plain = tavernRecipe(line('strawberry-lemonade'));
  assert.equal(plain.draft, true);
  assert.equal(plain.cup, 'Glass tavern mug');
  assert.ok(plain.ingredients.some((i) => i.what === 'Strawberry syrup' && i.amount === '25 ml'));
  assert.ok(plain.steps.some((s) => /soda water slowly/i.test(s)));
  // frozen: blended with water, never soda water
  const frozen = tavernRecipe(line('strawberry-lemonade', { frozen: true }));
  assert.ok(frozen.steps.some((s) => /blender/.test(s) && /150 ml water/.test(s)));
  assert.ok(!frozen.steps.some((s) => /^Soda water slowly/.test(s)));
  // oat milk replaces the creamer; add sweetness adds sugar syrup; a takeaway cup is sealed
  const oat = tavernRecipe(line('honeydew-milk', { oat: true, sweet: true, takeaway: true, extraTopping: 'blueberry-pearls' }));
  assert.ok(oat.ingredients.some((i) => /^Oat milk/.test(i.what)));
  assert.ok(!oat.ingredients.some((i) => i.what === 'Creamer'));
  assert.ok(oat.ingredients.some((i) => /sugar syrup/i.test(i.what)));
  assert.ok(oat.ingredients.some((i) => /Blueberry popping pearls \(extra\)/.test(i.what)));
  assert.equal(oat.cup, 'Takeaway cup (seal it)');
  // less ice and no ice
  assert.ok(tavernRecipe(line('taro-milk', { ice: 'less' })).ingredients.some((i) => i.what === 'Ice' && i.amount === '½ scoop'));
  assert.ok(tavernRecipe(line('blue-lychee', { ice: 'none' })).steps.some((s) => /^No ice/.test(s)));
  // the matcha sits in a layer; the milk tea brews a black tea bag; hot chocolate is a sachet
  assert.ok(tavernRecipe(line('strawberry-matcha')).steps.some((s) => /layer/.test(s)));
  assert.ok(tavernRecipe(line('brown-sugar-milk-tea')).ingredients.some((i) => /Black tea bag/.test(i.what)));
  const choc = tavernRecipe(line('hot-chocolate'));
  assert.equal(choc.cup, 'Hot mug');
  assert.ok(choc.ingredients.some((i) => i.what === 'Hot chocolate sachet'));
  assert.ok(tavernRecipe(line('pukka', { choice: 'Three mint' })).steps.some((s) => /5 minutes/.test(s)));
  // Brew Your Own: two fruit flavours share the syrup, two powders share the scoops
  const byo = tavernRecipe(line('brew-your-own', { base: 'sparkling', flavours: ['fruit-cherry', 'fruit-lemon'], topping: 'strawberry-pearls' }));
  assert.ok(byo.ingredients.some((i) => i.what === 'Cherry syrup' && i.amount === '20 ml'));
  const byoCream = tavernRecipe(line('brew-your-own', { base: 'creamer', flavours: ['creamy-taro', 'creamy-coconut'], topping: 'mango-pearls' }));
  assert.ok(byoCream.ingredients.some((i) => i.what === 'Taro powder' && i.amount === '2 scoops'));
  assert.ok(byoCream.ingredients.some((i) => i.what === 'Creamer'));
  // every drink on the menu has a card with steps
  for (const item of TAVERN_ITEMS) {
    const options = item.kind === 'byo' ? { base: 'creamer', flavours: ['creamy-taro'], topping: 'mango-pearls' } : item.choices ? { choice: item.choices[0] } : {};
    const card = tavernRecipe(line(item.id, options));
    assert.ok(card.steps.length >= 2, item.id);
    assert.ok(card.ingredients.length >= 2, item.id);
  }
});

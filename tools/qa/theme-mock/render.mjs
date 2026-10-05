// Local preview renderer for the Dice Goblin theme (layout + JSON templates + sections)
// using liquidjs with Shopify-ish tags/filters and mock store data. For visual QA only.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Liquid, Tag } from 'liquidjs';
import { lairEvents } from './events-mock.mjs'; // the real weekly Lair events (events worktree)

const THEME = process.env.DG_THEME || '/home/claude/dg-theme';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(THEME, p), 'utf8');
const readJson = (p) => JSON.parse(read(p).replace(/^\s*\/\*[\s\S]*?\*\//, ''));

/* ---------------- mock data ---------------- */
const rawProducts = JSON.parse(fs.readFileSync(path.join(HERE, 'products.json'), 'utf8'));
let mediaId = 1000;
const img = (seed, w, h, alt = '') => ({ __seed: seed, width: w, height: h, aspect_ratio: w / h, alt, src: seed, id: mediaId++, media_type: 'image' });
function product(h, title, vendor, min, max, compare, single, inv, w, h2, extra = {}) {
  const media = img(`${h}__${w}x${h2}`, w, h2, '');
  media.preview_image = media;
  const variant = { id: mediaId++, price: min * 100, compare_at_price: compare ? compare * 100 : null, available: inv > 0, inventory_management: 'shopify', inventory_quantity: inv, title: 'Default Title', options: ['Default Title'], featured_media: null, quantity_rule: {} };
  return {
    id: mediaId++, handle: h, title, vendor, url: `/products/${h}`, price: min * 100, price_min: min * 100, price_max: max * 100,
    price_varies: min !== max, compare_at_price: compare ? compare * 100 : null, available: inv > 0, has_only_default_variant: single,
    requires_selling_plan: false, featured_media: media, media: [media], selected_or_first_available_variant: variant, variants: [variant],
    options_with_values: single ? [] : [{ name: 'Type', position: 1, selected_value: 'Booster', values: ['Booster', 'Box'] }],
    description: `<p>${title} is here. A short Gobgob-voice description lives in the real store.</p>`,
    metafields: { custom: {}, shopify: {} }, tags: [], ...extra,
  };
}
const arrivals = rawProducts.map((r) => product(...r));
const ages = (label) => ({ value: [{ label: { value: label } }] });
const withStats = (p, players, time, age, code) => {
  p.metafields = { custom: { players: { value: players }, play_time: { value: time }, ...(code ? { library_code: { value: code } } : {}) }, shopify: { 'recommended-age-group': ages(age) } };
  return p;
};
const boardGames = [
  withStats(product('wingspan', 'Wingspan', 'Stonemaier Games', 95, 95, null, true, 4, 1000, 1000), '1–5', '40–70 min', '10 years or older'),
  withStats(product('cascadia', 'Cascadia', 'Flatout Games', 65, 65, 75, true, 2, 1000, 1000), '1–4', '30–45 min', '10 years or older'),
  withStats(product('sushi-go-party', 'Sushi Go Party!', 'Gamewright', 45, 45, null, true, 0, 1000, 1000), '2–8', '20 min', '8 years or older'),
  withStats(product('heat-pedal-to-the-metal', 'Heat: Pedal to the Metal', 'Days of Wonder', 110, 110, null, true, 1, 1000, 1000), '1–6', '30–60 min', '10 years or older'),
  withStats(product('the-crew-mission-deep-sea', 'The Crew: Mission Deep Sea', 'KOSMOS', 32, 32, null, true, 6, 1000, 1000), '2–5', '20 min', '10 years or older'),
  withStats(product('everdell', 'Everdell', 'Tabletop Tycoon', 110, 110, null, true, 3, 1000, 1000), '1–4', '40–80 min', '13-18 years'),
];
const library = [
  withStats(product('1000-and-one-treasures', '1000 and One Treasures (Library)', 'HABA', 0, 0, null, true, 1, 1000, 1000), '2–4', '20 min', '5 years or older', 'DGLF-001'),
  withStats(product('221b-baker-street', '221B Baker Street: The Master Detective Game (Library)', 'Gibsons', 0, 0, null, true, 1, 1000, 1000), '2–6', '60–90 min', '10 years or older', 'DGL56-001'),
  withStats(product('5-minute-dungeon', '5-Minute Dungeon (Library)', 'Wiggles 3D', 0, 0, null, true, 1, 1000, 1000), '2–5', '5–30 min', '8 years or older', 'DGL56-002'),
];
/* ---- library additions (library worktree): shelf + type tags, a priced RPG book, a title without "(Library)" ---- */
const libTags = (p, tags) => { p.tags = ['Board Game Rental', ...tags]; return p; };
libTags(library[0], ['Family Games', 'Player Count 4', '30 min or less', 'Shelf kids and family']);
libTags(library[1], ['Player Count 5.6', 'Classic', 'Deduction', 'Shelf 5-6 players']);
libTags(library[2], ['Player Count 5.6', '30 min or less', 'Adventure', 'Card game', 'Co-op', 'Shelf 5-6 players']);
library.push(
  libTags(withStats(product('wyrmspan', 'Wyrmspan  (Library)', 'Stonemaier Games', 0, 0, null, true, 1, 1000, 1000), '1–5', '90 min', '12 years or older', 'DGL56-157'), ['Player Count 5.6', 'Shelf 5-6 players', 'Solo', 'Strategy']),
  libTags(withStats(product('7-wonders-duel-library', '7 Wonders Duel (Library)', 'Repos Production', 0, 0, null, true, 1, 1000, 1000), '2', '30 min', '10 years or older', 'DGL12-001'), ['Player Count 1.2.3', '30 min or less', 'Shelf 1-2 players', 'Strategy']),
  libTags(withStats(product('codenames', 'Codenames (Library)', 'Czech Games Edition', 0, 0, null, true, 1, 1000, 1000), '2–8', '15 min', '10 years or older', 'DGL7+-015'), ['Player Count 7+', '30 min or less', 'Classic', 'Party', 'Shelf 7+ players', 'Word and trivia']),
  libTags(withStats(product('paladins-of-the-west-kingdom', 'Paladins of the West Kingdom', 'Garphill Games', 0, 0, null, true, 1, 1000, 1000), '1–4', '90–120 min', '12 years or older', 'DGL34-094'), ['Player Count 4', 'Shelf 3-4 players', 'Solo', 'Strategy']),
  libTags(withStats(product('forbidden-island', 'Forbidden Island (Library)', 'Gamewright', 0, 0, null, true, 3, 1000, 1000), '2–4', '30 min', '10 years or older', 'DGL34-052'), ['Family Games', 'Player Count 4', '30 min or less', 'Adventure', 'Co-op', 'Shelf 3-4 players']),
  libTags(withStats(product('jenga', 'Jenga (Library)', 'Hasbro', 0, 0, null, true, 1, 1000, 1000), '1+', '20 min', '6 years or older', 'DGLF-025'), ['Family Games', '30 min or less', 'Classic', 'Dexterity', 'Party', 'Shelf kids and family']),
  libTags(withStats(product('d-d-bigby-library', 'D&D Bigby Presents Glory of the Giants (Library)', 'Wizards of the Coast', 92, 92, null, true, 1, 1000, 1000), '2–6', '', '', 'DGLRPG-008'), ['RPG', 'Shelf RPG books']),
  libTags(withStats(product('mysterium', 'Mysterium (Library)', 'Libellud', 0, 0, null, true, 1, 1000, 1000), '2–7', '42 min', '10 years or older', 'DGL7+-056'), ['Player Count 7+', 'Co-op', 'Deduction', 'Shelf 7+ players']),
);
/* ev2: the one library copy in the store with a barcode (its ISBN), so the borrow card's QR uses the barcode */
library.find((p) => p.handle === 'd-d-bigby-library').variants[0].barcode = '9780786968992';
/* r6 library holds: fixed ids for the library copies (product 810000000000NN, variant 481000000000NN, NN their place
   in this list from 1), so the demo's seeded holds in assets/lair-demo.js (7 Wonders Duel held by Aroha, and the
   rest) land on these games, and the flow checks can name them. Inventory is their copies (Forbidden Island has 3). */
library.forEach((p, i) => {
  p.id = 81000000000000 + i + 1;
  p.variants[0].id = 48100000000000 + i + 1;
});
/* the membership: requires a selling plan, three monthly plans (prices set by the plan, like Simplee does) */
const sellingPlan = (id, name, description, cents, option, groupId) => ({
  id, name, description, group_id: groupId, recurring_deliveries: true, selected: false,
  options: [{ name: 'Membership Length', position: 1, value: option }],
  price_adjustments: [{ position: 1, order_count: null, value_type: 'price', value: cents }],
  checkout_charge: { value_type: 'percentage', value: 100 },
});
const planLoot = sellingPlan(10537140327, "Goblin's Loot", 'Borrow 1 game at a time. Swap as often as you like all month.', 3000, "Goblin's Loot 1 month", '6127550567');
const planTreasure = sellingPlan(10537205863, "Goblin's Treasure", 'Borrow up to 3 games at once. Unlimited swaps.', 6000, "Goblin's Treasure 1 month", '6127616103');
const planHoard = sellingPlan(10537369703, "Goblin's Hoard", 'Borrow up to 5 games at once. Unlimited swaps. Ultimate hoard access.', 7500, "Goblin's Hoard 1 month", '6127779943');
const allocation = (plan) => ({ selling_plan: plan, selling_plan_group_id: plan.group_id, price: plan.price_adjustments[0].value, compare_at_price: 3000, per_delivery_price: plan.price_adjustments[0].value, checkout_charge_amount: plan.price_adjustments[0].value, remaining_balance_charge_amount: 0, price_adjustments: [{ position: 1, price: plan.price_adjustments[0].value }], unit_price: null });
const membership = product('board-game-rental-monthly', 'Board Game Rental Membership', 'Dice Goblin NZ', 30, 30, null, true, 0, 1000, 1000);
membership.requires_selling_plan = true;
membership.available = true;
membership.template_suffix = 'membership';
membership.selling_plan_groups = [
  { id: '6127550567', name: 'Goblin Loot - Board Game Rental', app_id: null, selling_plan_selected: false, options: [{ name: 'Membership Length', position: 1, values: ["Goblin's Loot 1 month"], selected_value: null }], selling_plans: [planLoot] },
  { id: '6127616103', name: 'Goblin Treasure - Board Game Rental', app_id: null, selling_plan_selected: false, options: [{ name: 'Membership Length', position: 1, values: ["Goblin's Treasure 1 month"], selected_value: null }], selling_plans: [planTreasure] },
  { id: '6127779943', name: 'Goblin Hoard - Board Game Rental', app_id: null, selling_plan_selected: false, options: [{ name: 'Membership Length', position: 1, values: ["Goblin's Hoard 1 month"], selected_value: null }], selling_plans: [planHoard] },
];
membership.variants[0].available = true;
membership.variants[0].inventory_management = null;
membership.variants[0].selling_plan_allocations = [allocation(planLoot), allocation(planTreasure), allocation(planHoard)];
membership.variants[0].requires_selling_plan = true;
membership.selected_or_first_available_selling_plan_allocation = membership.variants[0].selling_plan_allocations[0];
membership.selected_selling_plan = null;
membership.description = '<p>Mock membership description. The real one is set in Shopify admin.</p>';
/* ---- shop sub-categories (nav worktree): the TCG and RPG collections carry the store's game and system tags, so their
   chip rows render. Their first three products stay as they were (the home tiles show them). Nothing is tagged Gundam
   or Star Wars Unlimited, so those two chips stay hidden. ---- */
const tagged = (p, tags) => { p.tags = [...(p.tags || []), ...tags]; return p; };
const tcgShelf = [
  tagged(arrivals[2], ['One Piece']), tagged(arrivals[3], ['Cyberpunk TCG']), tagged(arrivals[7], ['Riftbound LOL']),
  tagged(arrivals[4], ['Magic: The Gathering']), tagged(arrivals[15], ['Magic: The Gathering']),
  tagged(product('pokemon-tcg-151-booster-bundle', 'Pokémon TCG: 151 Booster Bundle', 'The Pokémon Company', 55, 55, null, true, 6, 1000, 1000), ['Pokemon']),
  tagged(arrivals[21], ['Yu-Gi-Oh']), tagged(arrivals[5], ['Riftbound LOL', 'Accessories']), tagged(arrivals[8], ['Accessories']),
];
const rpgShelf = [
  arrivals[9], arrivals[10], arrivals[11],
  tagged(product('dnd-players-handbook-2024', "D&D Player's Handbook (2024)", 'Wizards of the Coast', 85, 85, null, true, 5, 1000, 1000), ['Dungeons & Dragons']),
  tagged(product('call-of-cthulhu-starter-set', 'Call of Cthulhu Starter Set', 'Chaosium', 45, 45, null, true, 3, 1000, 1000), ['Call of Cthulhu']),
  tagged(product('mothership-core-set', 'Mothership: Core Set', 'Tuesday Knight Games', 70, 70, null, true, 2, 1000, 1000), ['Other RPGs']),
  tagged(product('polyhedral-dice-set-moonstone', 'Polyhedral dice set: Moonstone', 'Dice Goblin NZ', 18, 18, null, true, 9, 1000, 1000), ['Accessories']),
];
const coll = (handle, title, products, count) => ({
  handle, title, url: `/collections/${handle}`, products, products_count: count ?? products.length, all_products_count: count ?? products.length,
  description: '', filters: [], sort_options: [{ value: 'created-descending', name: 'Newest' }, { value: 'price-ascending', name: 'Price, low to high' }], sort_by: '', default_sort_by: 'created-descending',
});
const collections = {
  'new-additions': coll('new-additions', 'New Additions', arrivals, 376), // r7 shell: two sold-out products join it below
  'board-game': coll('board-game', 'Board Games', boardGames, 143),
  'family-games': coll('family-games', 'Family Games', [boardGames[2], boardGames[4], boardGames[1]], 190),
  'role-playing-game': coll('role-playing-game', 'Role Playing Game', rpgShelf, 105),
  'trading-card-games': coll('trading-card-games', 'Trading Card Games', tcgShelf, 139),
  painting: coll('painting', 'Painting', [arrivals[0], arrivals[1], arrivals[5]], 4),
  'toys-plush': coll('toys-plush', 'Toys/Plush', [arrivals[1], arrivals[8], arrivals[6]], 8),
  'board-game-rental': coll('board-game-rental', 'Board Game Rental', [membership, ...library], 534),
};
membership.collections = [collections['board-game-rental']];
/* r7 shell: sold-out products (the store has about 130), which the shop must never show: first and fifth in New
   Additions (so the home rail and the collection have to skip them) and one more in Trading Card Games. Inventory 0. */
const soldOut = [
  product('ark-nova', 'Ark Nova', 'Capstone Games', 120, 120, null, true, 0, 1000, 1000),
  product('pokemon-tcg-mega-charizard-x-ex-upc', 'Pokémon TCG: Mega Charizard X ex Ultra-Premium Collection', 'The Pokémon Company', 350, 350, null, true, 0, 1000, 1000, { tags: ['Pokemon'] }),
  product('dice-tower-dragon-keep', 'Dice tower: Dragon keep', 'Dice Goblin NZ', 45, 45, null, true, 0, 1000, 1000),
];
collections['new-additions'].products = [soldOut[0], ...arrivals.slice(0, 3), soldOut[2], ...arrivals.slice(3)];
collections['trading-card-games'].products.splice(1, 0, soldOut[1]);
const allProducts = Object.fromEntries([...arrivals, ...boardGames, ...library, membership, ...tcgShelf, ...rpgShelf, ...soldOut].map((p) => [p.handle, p]));
const pages = {
  'book-a-table': { handle: 'book-a-table', title: 'Book a Table or Session', url: '/pages/book-a-table', content: '' },
  'gm-games': { handle: 'gm-games', title: 'Book a TTRPG session', url: '/pages/gm-games', content: '' },
  'events-calendar': { handle: 'events-calendar', title: 'Events Calendar', url: '/pages/events-calendar', content: '' },
  'board-game-rental': { handle: 'board-game-rental', title: 'Board Game Rental', url: '/pages/board-game-rental', content: '' },
  'lair-staff': { handle: 'lair-staff', title: 'Lair staff', url: '/pages/lair-staff', content: '' },
  contact: { handle: 'contact', title: 'Contact', url: '/pages/contact', content: '' },
  'dice-goblin-board-game-rental-membership': { handle: 'dice-goblin-board-game-rental-membership', title: 'Membership terms', url: '/pages/dice-goblin-board-game-rental-membership', content: '' },
};
const link = (title, url, links = []) => ({ title, url, links, current: false });
const linklists = {
  'dg-main-menu': {
    title: 'Main menu',
    links: [
      link('Shop', '/collections/all', [link('New arrivals', '/collections/new-additions'), link('Board games', '/collections/board-game'), link('Family games', '/collections/family-games'), link('Role-playing games', '/collections/role-playing-game'), link('Trading card games', '/collections/trading-card-games'), link('Painting and hobby', '/collections/painting'), link('Plush and toys', '/collections/toys-plush'), link('Everything', '/collections/all')]),
      link('Book a table', '/pages/book-a-table'),
      link('Book a TTRPG session', '/pages/gm-games'),
      link('Events', '/pages/events-calendar'),
      link('Library', '/pages/board-game-rental'), // r7: below Events, as on the store
      link('Contact', '/pages/contact'),
    ],
  },
  'dg-footer-shop': { title: 'Shop', links: [link('New arrivals', '/collections/new-additions'), link('Board games', '/collections/board-game'), link('Role-playing games', '/collections/role-playing-game'), link('Trading card games', '/collections/trading-card-games'), link('All products', '/collections/all')] },
  'dg-footer-lair': { title: 'The Lair', links: [link('Book a table', '/pages/book-a-table'), link('TTRPG sessions', '/pages/gm-games'), link('Events calendar', '/pages/events-calendar'), link('Board game library', '/pages/board-game-rental')] },
  footer: { title: 'Help', links: [link('Contact information', '/policies/contact-information'), link('Privacy policy', '/policies/privacy-policy'), link('Refund policy', '/policies/refund-policy'), link('Terms of service', '/policies/terms-of-service')] },
  'main-menu': { title: 'Main menu', links: [] },
};

/* ---------------- settings resolution ---------------- */
const resolveValue = (type, value) => {
  if (value == null || value === '') return value;
  switch (type) {
    case 'collection': return collections[value] || null;
    case 'product': return allProducts[value] || null;
    case 'product_list': return (Array.isArray(value) ? value : []).map((h) => allProducts[h]).filter(Boolean);
    case 'page': return pages[value] || null;
    case 'link_list': return linklists[value] || { title: value, links: [] };
    case 'image_picker': return img(String(value).replace(/^shopify:\/\/shop_images\//, 'logo__'), 512, 512, '');
    case 'url': return String(value).replace(/^shopify:\/\/(pages|collections|products|blogs)\//, '/$1/');
    default: return value;
  }
};
const schemaOf = (file) => {
  const m = read(file).match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/);
  return m ? JSON.parse(m[1]) : { settings: [], blocks: [] };
};
const resolveSettings = (defs, values = {}) => {
  const out = {};
  for (const def of defs || []) {
    if (!def.id) continue;
    const v = values[def.id] !== undefined ? values[def.id] : def.default;
    out[def.id] = resolveValue(def.type, v);
  }
  return out;
};
const globalSchema = readJson('config/settings_schema.json').flatMap((g) => g.settings || []);
const globalSettings = resolveSettings(globalSchema, readJson('config/settings_data.json').current);
export { globalSettings };
/** r7 shell: the mock catalogue, so a check can mark a product sold out (or back in stock) while it runs */
export { collections, allProducts };
/** Test hooks: a logged-in customer and a request interceptor (used by live.mjs). */
export const mockState = { customer: null, before: null };

/* ---------------- engine ---------------- */
const compiledCss = [];
const engine = new Liquid({
  root: [path.join(THEME, 'sections'), path.join(THEME, 'snippets')],
  extname: '.liquid',
  cache: false,
  strictFilters: false,
  strictVariables: false,
  jsTruthy: false,
});

function rawTag(name, onContent) {
  engine.registerTag(
    name,
    class extends Tag {
      constructor(token, remainTokens, liquid) {
        super(token, remainTokens, liquid);
        let content = '';
        let tok;
        while ((tok = remainTokens.shift())) {
          if (tok.name === `end${name}`) break;
          content += tok.getText();
        }
        onContent?.(content);
      }
      *render() {
        return '';
      }
    },
  );
}
const seenCss = new Set();
rawTag('schema');
rawTag('javascript');
rawTag('doc');
rawTag('stylesheet', (css) => {
  if (!seenCss.has(css)) {
    seenCss.add(css);
    compiledCss.push(css);
  }
});

function blockTag(name, wrap) {
  engine.registerTag(
    name,
    class extends Tag {
      constructor(token, remainTokens, liquid, parser) {
        super(token, remainTokens, liquid);
        this.args = token.args;
        this.tpls = [];
        const p = parser || liquid.parser;
        const stream = p
          .parseStream(remainTokens)
          .on(`tag:end${name}`, () => stream.stop())
          .on('template', (tpl) => this.tpls.push(tpl))
          .on('end', () => {
            throw new Error(`${name} not closed`);
          });
        stream.start();
      }
      *render(ctx, emitter) {
        yield* wrap.call(this, ctx, emitter);
      }
    },
  );
}
blockTag('style', function* (ctx, emitter) {
  emitter.write('<style>');
  yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
  emitter.write('</style>');
});
blockTag('form', function* (ctx, emitter) {
  const type = (this.args.match(/^\s*'([^']+)'/) || [])[1];
  const cls = (this.args.match(/class:\s*'([^']*)'/) || [])[1] || '';
  let id = (this.args.match(/id:\s*'([^']*)'/) || [])[1];
  if (!id) {
    const v = (this.args.match(/id:\s*([a-z_][\w.]*)/) || [])[1];
    if (v) id = yield this.liquid.evalValue(v, ctx);
  }
  const action = { product: '/cart/add', contact: '/contact', customer: '/contact#footer', storefront_password: '/password', new_comment: '/comments' }[type] || '/';
  emitter.write(`<form method="post" action="${action}"${id ? ` id="${id}"` : ''} class="${cls}">`);
  ctx.push({ form: { errors: null, posted_successfully: false } });
  yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
  ctx.pop();
  emitter.write('</form>');
});
blockTag('paginate', function* (ctx, emitter) {
  ctx.push({ paginate: { pages: 1, current_page: 1, parts: [], previous: null, next: null } });
  yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
  ctx.pop();
});

/* r7 shell: each section in its own wrapper, the way Shopify renders it: <div id="shopify-section-<id>"
   class="shopify-section [shopify-section-group-<group file>] [the schema's class]">, or the schema's tag. */
const sectionWrapper = (id, schema, html, group) => {
  const tag = schema.tag || 'div';
  const cls = ['shopify-section', group ? `shopify-section-group-${group}` : '', schema.class || ''].filter(Boolean).join(' ');
  return `<${tag} id="shopify-section-${id}" class="${cls}">${html}</${tag}>`;
};
async function renderSection(type, id, data = {}, group = '') {
  const file = `sections/${type}.liquid`;
  const schema = schemaOf(file);
  const settings = resolveSettings(schema.settings, data.settings || {});
  const blockDefs = Object.fromEntries((schema.blocks || []).map((b) => [b.type, b]));
  const order = data.block_order || Object.keys(data.blocks || {});
  const blocks = order.map((bid) => {
    const b = data.blocks[bid];
    return { id: bid, type: b.type, settings: resolveSettings(blockDefs[b.type]?.settings, b.settings), shopify_attributes: '' };
  });
  const src = read(file).replace(/\{%-?\s*render block\s*-?%\}/g, '');
  const html = await engine.parseAndRender(src, { ...scope, section: { id, settings, blocks } });
  return sectionWrapper(id, schema, html, group);
}

engine.registerTag(
  'section',
  class extends Tag {
    constructor(token, remainTokens, liquid) {
      super(token, remainTokens, liquid);
      this.name = token.args.replace(/['"\s]/g, '');
    }
    *render() {
      return yield renderSection(this.name, this.name, {});
    }
  },
);
engine.registerTag(
  'sections',
  class extends Tag {
    constructor(token, remainTokens, liquid) {
      super(token, remainTokens, liquid);
      this.name = token.args.replace(/['"\s]/g, '');
    }
    *render() {
      const group = readJson(`sections/${this.name}.json`);
      let out = '';
      // r7 shell: Shopify's ids (sections--<n>__<key>), and a section switched off in the editor isn't rendered
      const n = { 'header-group': 1, 'footer-group': 2 }[this.name] || 3;
      for (const id of group.order) {
        if (group.sections[id].disabled) continue;
        out += yield renderSection(group.sections[id].type, `sections--${n}__${id}`, group.sections[id], this.name);
      }
      return out;
    }
  },
);

/* ---------------- filters ---------------- */
const locale = readJson('locales/en.default.json');
const lookup = (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), locale);
/* r7 shell: like Shopify, t HTML-escapes a translation whose key doesn't end in _html (so "We're" comes out
   "We&#39;re", which a JSON words block hands JS as is). DG_T_ESCAPE=0 turns that off. */
const tEscape = process.env.DG_T_ESCAPE !== '0';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
engine.registerFilter('t', (key, ...args) => {
  let v = lookup(key);
  const params = {};
  for (const a of args) if (Array.isArray(a)) params[a[0]] = a[1];
  if (v && typeof v === 'object') v = params.count === 1 ? v.one : v.other;
  if (v == null) return `[missing ${key}]`;
  const out = String(v).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => params[k] ?? '');
  return tEscape && !/_html$/.test(String(key)) ? escapeHtml(out) : out;
});
const hsl = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
};
const hex = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};
engine.registerFilter('color_lighten', (c, amt) => { const [h, s, l] = hsl(c); return hex(h, s, Math.min(100, l + amt)); });
engine.registerFilter('color_darken', (c, amt) => { const [h, s, l] = hsl(c); return hex(h, s, Math.max(0, l - amt)); });
engine.registerFilter('asset_url', (n) => `/assets/${n}`);
engine.registerFilter('shopify_asset_url', () => '#');
/* Stylesheets a page asks to preload (stylesheet_tag: preload: true). Shopify sends them as a Link response header,
   rel=preload; as=style (the tag itself is unchanged); serve() does the same. Reset for each page render. */
let preloads = [];
engine.registerFilter('stylesheet_tag', (u, ...args) => {
  if (args.some((a) => Array.isArray(a) && a[0] === 'preload' && a[1] === true)) preloads.push(u);
  return `<link rel="stylesheet" href="${u}">`;
});
engine.registerFilter('preload_tag', (u) => `<link rel="preload" href="${u}" as="font" crossorigin>`);
engine.registerFilter('image_url', (o, ...args) => {
  if (!o) return '';
  const w = (args.find((a) => Array.isArray(a) && a[0] === 'width') || [])[1] || 400;
  return `/img/${encodeURIComponent(o.__seed || o.src || 'x')}.svg?w=${w}`;
});
engine.registerFilter('image_tag', (u, ...args) => {
  const attrs = Object.fromEntries(args.filter(Array.isArray));
  const extra = Object.entries(attrs)
    .filter(([k]) => !['widths', 'sizes'].includes(k))
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  return `<img src="${u}"${extra}>`;
});
const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
engine.registerFilter('money', money);
engine.registerFilter('money_with_currency', (c) => `${money(c)} NZD`);
engine.registerFilter('money_without_currency', (c) => (Number(c || 0) / 100).toFixed(2));
engine.registerFilter('money_without_trailing_zeros', (c) => { const v = Number(c || 0) / 100; return `$${Number.isInteger(v) ? v : v.toFixed(2)}`; });
engine.registerFilter('handleize', (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
engine.registerFilter('handle', (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
engine.registerFilter('payment_type_svg_tag', (t) => `<svg viewBox="0 0 38 24" width="38" height="24"><rect width="38" height="24" rx="3" fill="#fff"/><text x="19" y="15" font-size="7" text-anchor="middle" fill="#333">${t}</text></svg>`);
engine.registerFilter('time_tag', (d) => `<time>${d}</time>`);
engine.registerFilter('default_errors', () => '');
engine.registerFilter('format_code', (s) => s);
engine.registerFilter('structured_data', () => '{}');
engine.registerFilter('payment_button', () => '<div class="shopify-payment-button"><button class="button button--ghost button--block" type="button">Buy it now</button></div>');
for (const f of ['external_video_tag', 'video_tag', 'media_tag']) engine.registerFilter(f, () => '');

/* ---------------- scope ---------------- */
const shop = {
  name: 'Dice Goblin NZ', email: 'hello@example.com', url: 'https://www.dicegoblin.nz', description: '', money_format: '${{amount}}',
  customer_accounts_enabled: true, enabled_payment_types: ['visa', 'master', 'american_express', 'apple_pay'], password_message: '',
  address: { address1: '56/691 Manukau Road', address2: 'Royal Oak', city: 'Auckland', zip: '1023', country_code: 'NZ' },
};
const routes = {
  root_url: '/', cart_url: '/cart', cart_add_url: '/cart/add', cart_change_url: '/cart/change', cart_update_url: '/cart/update',
  search_url: '/search', predictive_search_url: '/search/suggest', collections_url: '/collections', account_url: '/account',
  account_login_url: '/account/login', product_recommendations_url: '/recommendations/products',
};
const emptyCart = { item_count: 0, items: [], total_price: 0, taxes_included: true, note: '', cart_level_discount_applications: [], currency: { iso_code: 'NZD' } };
const fullCart = {
  ...emptyCart, item_count: 3, total_price: 9500 + 4000,
  items: [
    { key: 'a:1', url: '/products/wingspan', image: boardGames[0].featured_media, product: boardGames[0], variant: { title: 'Default Title', quantity_rule: {} }, quantity: 1, final_line_price: 9500, original_line_price: 9500, properties: {}, line_level_discount_allocations: [] },
    { key: 'b:2', url: '/products/lair-table-fee', image: null, product: { title: 'Lair table fee', has_only_default_variant: true }, variant: { title: 'Default Title', quantity_rule: {} }, quantity: 4, final_line_price: 4000, original_line_price: 4000, properties: { Booking: 'GOB-7K2Q', Date: 'Saturday 3 October', Time: '2pm to 5pm', Tables: 'T3, T4', _booking: 'GOB-7K2Q' }, line_level_discount_allocations: [] },
  ],
};
let scope = {};
function makeScope(extra) {
  return {
    shop, routes, settings: globalSettings, collections, linklists, pages, metaobjects: { lair_event: { values: lairEvents() } }, cart: emptyCart, customer: mockState.customer,
    request: { locale: { iso_code: 'en' }, page_type: 'index', origin: 'http://localhost' }, template: { name: 'index', suffix: null },
    content_for_header: '<link rel="stylesheet" href="/compiled.css">', canonical_url: 'http://localhost/', page_title: 'Dice Goblin NZ',
    page_description: '', powered_by_link: '<a href="#">Powered by Shopify</a>', current_page: 1, additional_checkout_buttons: false,
    content_for_additional_checkout_buttons: '', recommendations: { performed: false }, ...extra,
  };
}

async function renderPage(templateName, extra = {}) {
  preloads = [];
  scope = makeScope(extra);
  engine.options.globals = scope;
  const tpl = readJson(`templates/${templateName}.json`);
  let content = '';
  for (const id of tpl.order) {
    if (tpl.sections[id].disabled) continue; // Shopify skips sections switched off in the editor
    content += await renderSection(tpl.sections[id].type, `template--1__${id}`, tpl.sections[id]);
  }
  const layout = read(`layout/${tpl.layout || 'theme'}.liquid`).replace('{{ content_for_layout }}', content.replace(/\$/g, '$$$$'));
  return engine.parseAndRender(layout, scope);
}

/* ---------------- placeholder images + server ---------------- */
function placeholderSvg(seed) {
  const [name, dims] = decodeURIComponent(seed).split('__');
  const [w, h] = (dims || '1000x1000').split('x').map(Number);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  if (name.startsWith('logo')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="#46d06c"/><text x="256" y="300" font-family="Arial Black" font-size="150" text-anchor="middle" fill="#16110f">DG</text></svg>`;
  }
  const label = name.replace(/-/g, ' ').slice(0, 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 38%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect x="${w * 0.18}" y="${h * 0.16}" width="${w * 0.64}" height="${h * 0.68}" rx="${w * 0.03}" fill="rgba(255,255,255,.18)"/><text x="${w / 2}" y="${h / 2}" font-family="Arial" font-weight="700" font-size="${w * 0.055}" text-anchor="middle" fill="#fff">${label}</text></svg>`;
}

const PAGES = {
  '/': () => renderPage('index'),
  '/cart-open': () => renderPage('index', { cart: fullCart }),
  '/products/wingspan': () => renderPage('product', { product: boardGames[0], request: { page_type: 'product', locale: { iso_code: 'en' }, origin: '' }, template: { name: 'product' } }),
  '/products/library': () => renderPage('product', { product: library[1], request: { page_type: 'product', locale: { iso_code: 'en' }, origin: '' }, template: { name: 'product' } }),
  '/collections/new-additions': () => shopCollectionPage('new-additions'), // r7 shell: with the store's filters
  '/pages/book-a-table': () => renderPage('page.bookings', { page: pages['book-a-table'], template: { name: 'page', suffix: 'bookings' } }),
  '/pages/gm-games': () => renderPage('page.gm-games', { page: pages['gm-games'], template: { name: 'page', suffix: 'gm-games' } }),
  '/pages/events-calendar': () => renderPage('page.events-calendar', { page: pages['events-calendar'], template: { name: 'page', suffix: 'events-calendar' } }),
  '/pages/lair-staff': () => renderPage('page.lair-staff', { page: pages['lair-staff'], template: { name: 'page', suffix: 'lair-staff' } }),
  '/pages/board-game-rental': () => renderPage('page.board-game-rental', { page: pages['board-game-rental'], template: { name: 'page', suffix: 'board-game-rental' } }),
  '/404': () => renderPage('404', { template: { name: '404' } }),
  '/pages/contact': () => renderPage(hasTemplate('page.contact') ? 'page.contact' : 'page', { page: pages.contact, template: { name: 'page', suffix: 'contact' } }),
};

/* ---- library routes (library worktree): tag-filtered library collection, membership, terms, search ---- */
const handleize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CONTENT_DIR = path.join(HERE, '..', 'library-content');
const contentFile = (name) => { try { return fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8'); } catch { return ''; } };
Object.defineProperty(pages['board-game-rental'], 'content', { get: () => contentFile('library-page.html'), enumerable: true });
Object.defineProperty(pages['dice-goblin-board-game-rental-membership'], 'content', { get: () => contentFile('terms.html'), enumerable: true });
pages['dice-goblin-board-game-rental-membership'].title = 'Library membership terms';
membership.description = contentFile('membership.html') || membership.description;
const hasTemplate = (name) => fs.existsSync(path.join(THEME, 'templates', `${name}.json`));
const productPage = (p, extra = {}) => {
  const suffix = p.template_suffix && hasTemplate(`product.${p.template_suffix}`) ? p.template_suffix : null;
  return renderPage(suffix ? `product.${suffix}` : 'product', { product: p, request: { page_type: 'product', locale: { iso_code: 'en' }, origin: '' }, template: { name: 'product', suffix }, ...extra });
};
function libraryRoute(url) {
  const m = url.pathname.match(/^\/collections\/board-game-rental(?:\/([^/]+))?\/?$/);
  if (m) {
    const tags = m[1] ? m[1].split('+').map(handleize) : [];
    const base = collections['board-game-rental'];
    const items = base.products.filter((p) => tags.every((t) => (p.tags || []).some((pt) => handleize(pt) === t)));
    const view = { ...base, products: items, products_count: tags.length ? items.length : base.all_products_count, tags: [...new Set(items.flatMap((p) => p.tags || []))], all_tags: [...new Set(base.products.flatMap((p) => p.tags || []))], sort_by: url.searchParams.get('sort_by') || '' };
    const name = hasTemplate('collection.board-game-rental') ? 'collection.board-game-rental' : 'collection';
    return () => renderPage(name, { collection: view, current_tags: tags.length ? tags : null, request: { page_type: 'collection', locale: { iso_code: 'en' }, origin: '', path: url.pathname }, template: { name: 'collection', suffix: name.includes('.') ? 'board-game-rental' : null } });
  }
  if (url.pathname === '/products/board-game-rental-monthly') {
    const id = Number(url.searchParams.get('selling_plan'));
    const plan = [planLoot, planTreasure, planHoard].find((p) => p.id === id) || null;
    const p = { ...membership, selected_selling_plan: plan, selected_or_first_available_selling_plan_allocation: plan ? allocation(plan) : membership.variants[0].selling_plan_allocations[0] };
    if (url.searchParams.get('generic')) p.template_suffix = null;
    return () => productPage(p);
  }
  const pm = url.pathname.match(/^\/products\/([^/]+)$/);
  if (pm && allProducts[pm[1]]) return () => productPage(allProducts[pm[1]]);
  if (url.pathname === '/pages/dice-goblin-board-game-rental-membership') {
    return () => renderPage('page.rent-terms-and-conditions', { page: pages['dice-goblin-board-game-rental-membership'], template: { name: 'page', suffix: 'rent-terms-and-conditions' } });
  }
  if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let found = Object.values(allProducts).filter((p) => q && p.title.toLowerCase().includes(q));
    // r7 shell: options[unavailable_products] as Shopify takes it (hide, show, or last by default), and the store's filters
    const unavailable = url.searchParams.get('options[unavailable_products]') || 'last';
    if (unavailable === 'hide') found = found.filter((p) => p.available);
    else if (unavailable === 'last') found = [...found.filter((p) => p.available), ...found.filter((p) => !p.available)];
    const { kept, filters } = storeFilters(found, url);
    const results = kept.map((p) => ({ ...p, object_type: 'product' }));
    return () => renderPage('search', { search: { performed: Boolean(q), terms: q, results, results_count: results.length, filters, sort_options: [] }, request: { page_type: 'search', locale: { iso_code: 'en' }, origin: '' }, template: { name: 'search' } });
  }
  if (url.pathname === '/cart-membership') {
    const line = (p, qty, extra = {}) => ({ key: `${p.handle}:1`, url: p.url, image: p.featured_media, product: p, variant: { title: 'Default Title', quantity_rule: {} }, quantity: qty, final_line_price: p.price * qty, original_line_price: p.price * qty, properties: {}, line_level_discount_allocations: [], ...extra });
    const cart = { ...emptyCart, item_count: 3, total_price: 6000 + 9500, items: [line(membership, 1, { final_line_price: 6000, original_line_price: 6000, selling_plan_allocation: allocation(planTreasure), properties: { '_Did you read and accept the Terms and Conditions?': 'Yes' } }), line(boardGames[0], 1), line(library[3], 1, { final_line_price: 0, original_line_price: 0 })] };
    return () => renderPage('index', { cart });
  }
  return null;
}
/* ---- shop sub-categories (nav worktree): the TCG and RPG collections, tag-filtered like the library
   (/collections/trading-card-games/pokemon), with collection.tags and all_tags ---- */
/* ---- r7 shell: the store's filters (Search & Discovery: Availability, Price, Vendor) on shop collections and search,
   read from the URL the way Shopify does (filter.v.availability=1|0, filter.v.price.gte/lte in dollars,
   filter.p.vendor) and handed to Liquid as filter objects with counts, active values and add/remove links ---- */
function storeFilters(products, url) {
  const params = url.searchParams;
  const list = (name) => params.getAll(name).flatMap((v) => v.split(',')).filter(Boolean);
  const avail = list('filter.v.availability');
  const vendors = list('filter.p.vendor');
  const cents = (name) => (params.get(name) ? Math.round(parseFloat(params.get(name)) * 100) : null);
  const min = cents('filter.v.price.gte');
  const max = cents('filter.v.price.lte');
  const pass = (p, skip) => (skip === 'a' || !avail.length || avail.includes(p.available ? '1' : '0'))
    && (skip === 'v' || !vendors.length || vendors.includes(p.vendor))
    && (skip === 'p' || ((min == null || p.price >= min) && (max == null || p.price <= max)));
  const link = (edit) => { const u = new URL(url); u.searchParams.delete('page'); edit(u.searchParams); return `${u.pathname}${u.search}`; };
  const listFilter = (label, param, chosen, skip, options) => {
    const pool = products.filter((p) => pass(p, skip));
    const values = options.map(([value, text, match]) => {
      const active = chosen.includes(value);
      return {
        label: text, value, param_name: param, active, count: pool.filter(match).length,
        url_to_add: link((s) => s.append(param, value)),
        url_to_remove: link((s) => { s.delete(param); chosen.filter((c) => c !== value).forEach((c) => s.append(param, c)); }),
      };
    });
    return { label, param_name: param, type: 'list', operator: 'OR', presentation: null, values, active_values: values.filter((v) => v.active), inactive_values: values.filter((v) => !v.active), url_to_remove: link((s) => s.delete(param)) };
  };
  const filters = [
    listFilter('Availability', 'filter.v.availability', avail, 'a', [['1', 'In stock', (p) => p.available], ['0', 'Out of stock', (p) => !p.available]]),
    { label: 'Price', param_name: 'filter.v.price', type: 'price_range', min_value: { param_name: 'filter.v.price.gte', value: min }, max_value: { param_name: 'filter.v.price.lte', value: max }, range_max: Math.max(0, ...products.map((p) => p.price)), url_to_remove: link((s) => { s.delete('filter.v.price.gte'); s.delete('filter.v.price.lte'); }) },
    listFilter('Brand', 'filter.p.vendor', vendors, 'v', [...new Set(products.map((p) => p.vendor))].sort().map((v) => [v, v, (p) => p.vendor === v])),
  ];
  return { kept: products.filter((p) => pass(p)), filters, active: Boolean(avail.length || vendors.length || min != null || max != null) };
}
function shopCollectionPage(handle, tags = [], sortBy = '', url = new URL(`http://localhost/collections/${handle}`)) {
  const base = collections[handle];
  const tagged = base.products.filter((p) => tags.every((t) => (p.tags || []).some((pt) => handleize(pt) === t)));
  const { kept: items, filters, active } = storeFilters(tagged, url);
  const view = { ...base, products: items, products_count: tags.length || active ? items.length : base.all_products_count, filters, tags: [...new Set(items.flatMap((p) => p.tags || []))], all_tags: [...new Set(base.products.flatMap((p) => p.tags || []))], sort_by: sortBy };
  return renderPage('collection', { collection: view, current_tags: tags.length ? tags : null, request: { page_type: 'collection', locale: { iso_code: 'en' }, origin: '', path: `/collections/${handle}` }, template: { name: 'collection', suffix: null } });
}
function shopCollectionRoute(url) {
  // r7 shell: every shop collection (the library's has its own route), with the URL's filters
  const m = url.pathname.match(/^\/collections\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m || m[1] === 'board-game-rental' || !collections[m[1]]) return null;
  const tags = m[2] ? m[2].split('+').map(handleize) : [];
  return () => shopCollectionPage(m[1], tags, url.searchParams.get('sort_by') || '', url);
}
PAGES['/collections/trading-card-games'] = () => shopCollectionPage('trading-card-games');
PAGES['/collections/role-playing-game'] = () => shopCollectionPage('role-playing-game');
function librarySuggest(url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  // resources[options][fields]=variants.barcode,variants.sku: a scanned code finds the product it's on (ml3)
  const fields = url.searchParams.get('resources[options][fields]') || '';
  const byCode = (p) => (p.variants || []).some((v) => (fields.includes('variants.barcode') && v.barcode && String(v.barcode).toLowerCase() === q)
    || (fields.includes('variants.sku') && v.sku && String(v.sku).toLowerCase() === q));
  // r7 shell: resources[options][unavailable_products] as Shopify takes it (hide, show, or last by default)
  const unavailable = url.searchParams.get('resources[options][unavailable_products]') || 'last';
  let matches = Object.values(allProducts).filter((p) => !p.unlisted && (p.title.toLowerCase().includes(q) || byCode(p)));
  if (unavailable === 'hide') matches = matches.filter((p) => p.available);
  else if (unavailable === 'last') matches = [...matches.filter((p) => p.available), ...matches.filter((p) => !p.available)];
  const products = matches.slice(0, 6)
    .map((p) => ({ title: p.title, handle: p.handle, url: p.url, price: (p.price / 100).toFixed(2), available: Boolean(p.available), tags: p.tags || [], image: `/img/${encodeURIComponent(p.featured_media?.__seed || 'x')}.svg?x=1` }));
  return { resources: { results: { products, collections: [], pages: [] } } };
}

/* ---- my-lair worktree: the My Lair page, a /collections/all/products.json feed (Shopify's shape, paged) and a
   cart that remembers lines and discount codes (/cart.js, add, update, change, /discount/CODE) for the d20 roller ---- */
pages['my-lair'] = { handle: 'my-lair', title: 'My Lair', url: '/pages/my-lair', content: '' };
routes.account_logout_url = '/account/logout';
routes.account_addresses_url = '/account/addresses';
PAGES['/pages/my-lair'] = () => (hasTemplate('page.my-lair')
  ? renderPage('page.my-lair', { page: pages['my-lair'], template: { name: 'page', suffix: 'my-lair' }, request: { page_type: 'page', locale: { iso_code: 'en' }, origin: '' } })
  : renderPage('page', { page: pages['my-lair'], template: { name: 'page', suffix: null } }));
export const PRIZE_VARIANT = 50363551023207;
/* ---- my-lair round 4 (ml3 worktree): the self-serve tab. The "Tab menu" products are real store data (prices in NZD,
   variant ids and barcodes as in Shopify). They're Unlisted there: reachable by handle, hidden from search, so search
   below skips them. A listed product with a (mock) barcode lets a scan reach the shop's search. ---- */
const tabProduct = (id, handle, title, rows) => {
  const media = img(`${handle}__600x600`, 600, 600, '');
  media.preview_image = media;
  const variants = rows.map(([vid, vtitle, dollars, barcode]) => ({
    id: vid, title: vtitle, price: Math.round(dollars * 100), compare_at_price: null, available: true, inventory_management: null, inventory_quantity: 0,
    barcode, sku: '', options: [vtitle], featured_media: null, quantity_rule: {},
  }));
  const prices = variants.map((v) => v.price);
  return {
    id, handle, title, vendor: 'Dice Goblin NZ', url: `/products/${handle}`, price: Math.min(...prices), price_min: Math.min(...prices), price_max: Math.max(...prices),
    price_varies: Math.min(...prices) !== Math.max(...prices), compare_at_price: null, available: true, has_only_default_variant: false, requires_selling_plan: false,
    featured_media: media, media: [media], selected_or_first_available_variant: variants[0], variants,
    options_with_values: [{ name: 'Title', position: 1, selected_value: variants[0].title, values: variants.map((v) => v.title) }],
    description: '', metafields: { custom: {}, shopify: {} }, tags: [], unlisted: true,
  };
};
export const tabMenu = [
  tabProduct(7666505744487, 'drinks', 'Drinks', [[44114644828263, '$2 Drink', 2, '31283123823'], [44114640568423, '$3 Drink', 3, '31283123821'], [44114640601191, '$6 Drink', 6, '31283123822']]),
  tabProduct(7666525732967, 'snacks-1', 'Snacks', [[44114682314855, '$3 Snack', 3, '31283123824'], [44114682347623, '$4 Snack', 4, '31283123825'], [44114682380391, '$6 Snack', 6, '31283123827']]),
  tabProduct(7666513936487, 'ice-cream', 'Ice Cream', [[44114654527591, '$6 Ice Cream', 6, '31283123830'], [44114654560359, '$5 Ice Cream', 5, '31283123829'], [44114654593127, '$4 Ice Cream', 4, '31283123828']]),
  tabProduct(7764090880103, 'poweraid', 'Poweraid', [[44531410829415, 'Mountain Blast', 6, '9300675024235'], [44531410862183, 'Berry Ice', 6, '9300675024259'], [44531410894951, 'Fever Pitch', 6, '9300675035699']]),
];
for (const p of tabMenu) allProducts[p.handle] = p;
const booster = product('pokemon-tcg-booster', 'Pokémon TCG: booster pack', 'The Pokémon Company', 9, 9, null, true, 24, 1000, 1000);
booster.variants[0].barcode = '9421906580017'; // mock barcode
booster.variants[0].sku = 'PKM-BOOSTER';
allProducts[booster.handle] = booster;
/** /products/<handle>.js, the Ajax API's product JSON: prices in cents, each variant's barcode and SKU */
const productJs = (p) => ({
  id: p.id, title: p.title, handle: p.handle, description: p.description || '', vendor: p.vendor, type: p.product_type || '', tags: p.tags || [],
  price: p.price, price_min: p.price_min ?? p.price, price_max: p.price_max ?? p.price, available: Boolean(p.available), url: p.url,
  featured_image: p.featured_media ? `/img/${encodeURIComponent(p.featured_media.__seed)}.svg?v=1` : null,
  variants: p.variants.map((v) => ({
    id: v.id, title: v.title, option1: v.title, option2: null, option3: null, price: v.price, compare_at_price: v.compare_at_price ?? null,
    available: Boolean(v.available), sku: v.sku || null, barcode: v.barcode || '', featured_image: null, requires_shipping: true, taxable: true,
  })),
});
const feedProducts = (() => {
  const extra = [];
  const kinds = [
    ['dice-set', 'Dice set', ['Dragon scale', 'Moonstone', 'Lava lamp', 'Pocket galaxy', 'Swamp witch', 'Rose gold', 'Glow worm', 'Kauri gum', 'Storm cloud', 'Pāua shell'], 'Gobgob Dice Co.', 18, 'Dice'],
    ['sleeves', 'Card sleeves', ['Matte black', 'Clear', 'Goblin green', 'Royal purple', 'Ocean blue'], 'Dragon Shield', 16, 'Accessories'],
    ['paint', 'Paint pot', ['Goblin green', 'Bone white', 'Ruby red', 'Gold leaf', 'Nuln oil'], 'Vallejo', 8, 'Painting'],
    ['mini', 'Miniature', ['Owlbear', 'Mimic chest', 'Beholder', 'Kobold trapper', 'Tavern keeper', 'Dire badger'], 'WizKids', 12, 'Miniatures'],
    ['game', 'Board game', ['Azul', 'Ticket to Ride', 'Catan', 'Root', 'Splendor', 'Patchwork', 'Carcassonne', 'Dixit', 'Jaipur', 'Kingdomino'], 'Asmodee', 65, 'Board Game'],
  ];
  let n = 0;
  for (const [slug, kind, names, vendor, price, type] of kinds) {
    for (const name of names) {
      n += 1;
      const handle = `${slug}-${handleize(name)}`;
      const p = product(handle, kind === 'Board game' ? name : `${kind}: ${name}`, vendor, price + (n % 4) * 3, price + (n % 4) * 3, null, true, n % 9 === 0 ? 0 : 3, 1000, 1000);
      p.product_type = type;
      extra.push(p);
    }
  }
  // A run of library copies in a row (the real feed has long runs of them), a hidden product, a gift card and the prize
  const libRun = Array.from({ length: 40 }, (_, i) => {
    const p = product(`library-copy-${i + 1}`, `Library game ${i + 1} (Library)`, 'Dice Goblin NZ', 0, 0, null, true, 1, 1000, 1000);
    p.tags = ['Board Game Rental'];
    return p;
  });
  const hidden = product('staff-only-thing', 'Staff-only thing', 'Dice Goblin NZ', 5, 5, null, true, 5, 1000, 1000);
  hidden.tags = ['hidden'];
  const gift = product('gift-card', 'Dice Goblin gift card', 'Dice Goblin NZ', 25, 100, null, true, 5, 1000, 1000);
  gift.product_type = 'Gift Card';
  const prize = product('dice-chest-prize', 'Free dice from the Dice Chest', 'Dice Goblin NZ', 6, 6, null, true, 50, 1000, 1000);
  prize.tags = ['dice-chest-prize', 'hidden'];
  prize.variants[0].id = PRIZE_VARIANT;
  prize.selected_or_first_available_variant = prize.variants[0];
  const all = [...arrivals, ...boardGames, ...extra.slice(0, 30), ...libRun, ...extra.slice(30), ...library, membership, hidden, gift, prize];
  return all;
})();
collections.all = coll('all', 'All products', [...arrivals, ...boardGames], feedProducts.length);
const variantIndex = new Map(feedProducts.flatMap((p) => p.variants.map((v) => [Number(v.id), { product: p, variant: v }])));
const feedJson = (p) => ({
  id: p.id, title: p.title, handle: p.handle, vendor: p.vendor, product_type: p.product_type || '', tags: p.tags || [],
  body_html: p.description || '',
  variants: p.variants.map((v) => ({ id: v.id, title: v.title, price: (v.price / 100).toFixed(2), compare_at_price: v.compare_at_price ? (v.compare_at_price / 100).toFixed(2) : null, available: Boolean(v.available) })),
  images: p.featured_media ? [{ src: `/img/${encodeURIComponent(p.featured_media.__seed)}.svg?v=1`, width: p.featured_media.width, height: p.featured_media.height }] : [],
});
export const mockCart = { lines: [], codes: [], note: '' };
function pricedCart() {
  const lines = mockCart.lines.map((l) => {
    const hit = variantIndex.get(Number(l.variantId));
    return { ...l, product: hit.product, variant: hit.variant, unit: hit.variant.price, off: 0, allocations: [] };
  });
  const applicable = {};
  for (const code of mockCart.codes) {
    if (/^NAT1-/i.test(code)) {
      const prize = lines.find((l) => Number(l.variantId) === PRIZE_VARIANT);
      applicable[code] = Boolean(prize && lines.some((l) => Number(l.variantId) !== PRIZE_VARIANT));
      if (applicable[code]) {
        prize.off = prize.unit;
        prize.allocations.push({ amount: prize.unit, discount_application: { title: code, type: 'discount_code' } });
      }
    }
  }
  const subtotal = lines.reduce((sum, l) => sum + l.unit * l.quantity - l.off, 0);
  const cartLevel = [];
  for (const code of mockCart.codes) {
    if (/^NAT20-/i.test(code)) {
      applicable[code] = subtotal > 0;
      if (subtotal > 0) cartLevel.push({ title: code, type: 'discount_code', value_type: 'percentage', value: '5.0', total_allocated_amount: Math.round(subtotal * 0.05) });
    } else if (!(code in applicable)) applicable[code] = false;
  }
  const total = subtotal - cartLevel.reduce((s, d) => s + d.total_allocated_amount, 0);
  return { lines, subtotal, total, cartLevel, applicable };
}
function cartJsonOut() {
  const c = pricedCart();
  return {
    token: 'mock', note: mockCart.note, attributes: {}, currency: 'NZD', requires_shipping: true,
    item_count: c.lines.reduce((s, l) => s + l.quantity, 0), items_subtotal_price: c.subtotal, total_price: c.total, original_total_price: c.lines.reduce((s, l) => s + l.unit * l.quantity, 0),
    total_discount: c.lines.reduce((s, l) => s + l.off, 0) + c.cartLevel.reduce((s, d) => s + d.total_allocated_amount, 0),
    cart_level_discount_applications: c.cartLevel,
    discount_codes: mockCart.codes.map((code) => ({ code, applicable: Boolean(c.applicable[code]) })),
    items: c.lines.map((l) => ({
      id: Number(l.variantId), variant_id: Number(l.variantId), key: l.key, quantity: l.quantity, title: l.product.title, product_title: l.product.title, handle: l.product.handle,
      url: l.product.url, price: l.unit, original_price: l.unit, final_price: l.unit - l.off / l.quantity, line_price: l.unit * l.quantity - l.off, final_line_price: l.unit * l.quantity - l.off,
      properties: l.properties || {}, image: `/img/${encodeURIComponent(l.product.featured_media?.__seed || 'x')}.svg`, discounts: l.allocations.map((a) => ({ amount: a.amount, title: a.discount_application.title })),
    })),
  };
}
function cartLiquid() {
  const c = pricedCart();
  return {
    ...emptyCart, note: mockCart.note, item_count: c.lines.reduce((s, l) => s + l.quantity, 0), total_price: c.total, cart_level_discount_applications: c.cartLevel,
    items: c.lines.map((l) => ({
      key: l.key, url: l.product.url, image: l.product.featured_media, product: l.product, variant: { title: l.variant.title, quantity_rule: {} }, quantity: l.quantity,
      final_line_price: l.unit * l.quantity - l.off, original_line_price: l.unit * l.quantity, properties: l.properties || {}, line_level_discount_allocations: l.allocations,
    })),
  };
}
async function cartSections(ids) {
  const out = {};
  const saved = engine.options.globals;
  const local = makeScope({ cart: cartLiquid() });
  engine.options.globals = local;
  try {
    for (const id of ids) {
      if (!fs.existsSync(path.join(THEME, 'sections', `${id}.liquid`))) continue;
      const schema = schemaOf(`sections/${id}.liquid`);
      const html = await engine.parseAndRender(read(`sections/${id}.liquid`), { ...local, section: { id, settings: resolveSettings(schema.settings, {}), blocks: [] } });
      out[id] = sectionWrapper(id, schema, html);
    }
  } finally {
    engine.options.globals = saved;
  }
  return out;
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return raw ? JSON.parse(raw) : {};
  if (type.includes('multipart/form-data')) {
    const out = {};
    for (const m of raw.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) out[m[1]] = m[2];
    return out;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
async function shopJson(req, res, url) {
  const productFile = url.pathname.match(/^\/products\/([^/]+)\.js$/);
  if (productFile) {
    const p = allProducts[decodeURIComponent(productFile[1])];
    if (p) sendJson(res, 200, productJs(p));
    else sendJson(res, 404, { status: 404, message: 'Not Found', description: 'Not Found' });
    return true;
  }
  if (url.pathname === '/collections/all/products.json') {
    const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    sendJson(res, 200, { products: feedProducts.slice((page - 1) * limit, page * limit).map(feedJson) });
    return true;
  }
  const discount = url.pathname.match(/^\/discount\/([^/]+)$/);
  if (discount) {
    const code = decodeURIComponent(discount[1]);
    if (!mockCart.codes.includes(code)) mockCart.codes.push(code);
    res.writeHead(302, { Location: url.searchParams.get('redirect') || '/cart', 'Set-Cookie': `discount_code=${encodeURIComponent(code)}; Path=/` });
    res.end();
    return true;
  }
  if (url.pathname === '/cart.js' && req.method === 'GET') {
    sendJson(res, 200, cartJsonOut());
    return true;
  }
  const action = (url.pathname.match(/^\/cart\/(add|update|change)\.js$/) || [])[1];
  if (!action || req.method !== 'POST') return false;
  const body = await readBody(req);
  const sectionIds = Array.isArray(body.sections) ? body.sections : String(body.sections || '').split(',').filter(Boolean);
  const addLine = (id, quantity, properties = {}) => {
    if (!variantIndex.has(Number(id))) return false;
    const key = `${id}:${Buffer.from(JSON.stringify(properties)).toString('hex').slice(0, 8) || '0'}`;
    const line = mockCart.lines.find((l) => l.key === key);
    if (line) line.quantity += quantity;
    else mockCart.lines.push({ key, variantId: Number(id), quantity, properties });
    return true;
  };
  if (action === 'add') {
    const items = Array.isArray(body.items) ? body.items : [{ id: body.id, quantity: body.quantity, properties: body.properties }];
    for (const item of items) {
      const hit = variantIndex.get(Number(item.id));
      if (!hit || !hit.variant.available) {
        sendJson(res, 422, { status: 422, message: 'Cart Error', description: hit ? `${hit.product.title} is sold out.` : 'Cannot find variant' });
        return true;
      }
    }
    items.forEach((item) => addLine(item.id, Number(item.quantity) || 1, item.properties || {}));
    sendJson(res, 200, { items: cartJsonOut().items, sections: await cartSections(sectionIds) });
    return true;
  }
  if (action === 'update') {
    if (body.updates) {
      for (const [id, qty] of Object.entries(body.updates)) {
        const line = mockCart.lines.find((l) => l.key === id || String(l.variantId) === String(id));
        if (line) line.quantity = Number(qty);
        else if (Number(qty) > 0) addLine(id, Number(qty));
      }
      mockCart.lines = mockCart.lines.filter((l) => l.quantity > 0);
    }
    if (typeof body.discount === 'string') mockCart.codes = body.discount.split(',').map((s) => s.trim()).filter(Boolean);
    if (typeof body.note === 'string') mockCart.note = body.note;
    sendJson(res, 200, { ...cartJsonOut(), sections: await cartSections(sectionIds) });
    return true;
  }
  const line = mockCart.lines.find((l) => l.key === body.id || String(l.variantId) === String(body.id));
  if (line) line.quantity = Number(body.quantity);
  mockCart.lines = mockCart.lines.filter((l) => l.quantity > 0);
  sendJson(res, 200, { ...cartJsonOut(), sections: await cartSections(sectionIds) });
  return true;
}

export function serve(port = 4173) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (mockState.before && (await mockState.before(req, res, url))) return;
      if (await shopJson(req, res, url)) return;
      if (url.pathname.startsWith('/assets/')) {
        const file = path.join(THEME, 'assets', path.basename(url.pathname));
        const ext = path.extname(file);
        res.writeHead(200, { 'Content-Type': { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
        return;
      }
      if (url.pathname === '/compiled.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(compiledCss.join('\n'));
        return;
      }
      if (url.pathname.startsWith('/img/')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(placeholderSvg(url.pathname.slice(5).replace(/\.svg$/, '')));
        return;
      }
      if (url.pathname === '/search/suggest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(librarySuggest(url)));
        return;
      }
      const page = shopCollectionRoute(url) || PAGES[url.pathname] || libraryRoute(url); // r7 shell: shop collections read their filters first
      if (!page) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const html = await page();
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (preloads.length) headers.Link = [...new Set(preloads)].map((u) => `<${u}>; rel=preload; as=style`).join(', ');
      res.writeHead(200, headers);
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error.stack || error));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[2] === 'check') {
  for (const [route, fn] of Object.entries(PAGES)) {
    try {
      const html = await fn();
      const missing = html.match(/\[missing [^\]]+\]/g) || [];
      console.log(route, 'ok', html.length, missing.length ? missing.slice(0, 5) : '');
    } catch (error) {
      console.log(route, 'ERROR', error.message.slice(0, 400));
    }
  }
}

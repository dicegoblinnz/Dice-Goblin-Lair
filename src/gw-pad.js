/**
 * Round 26 (31 Oct 2026, contract v26-gw-pad): Games Workshop's weekly order pad into Shopify, from the staff page's
 * Warhammer tab. Mo (31 Oct 2026): "how do we tackle the ordered products? Do we add them online? With the same
 * context?" Everything on the pad goes into Shopify set up like the live GW listings: its name as its description (Mo:
 * "just write the name of the product on the description"), the plain Google line, selling at 0 so it's ordered in.
 * New products are on the till only (Point of Sale) until each has GW's picture; going online comes after. Each week's
 * pad keeps the shop in step: new lines added, prices, costs, barcodes, pack sizes, release dates and the New release
 * tag kept current, and lines that drop off the pad stop selling at 0 (they sell what's on the shelf).
 *
 * GW's words are never changed (Mo's rep, 31 Oct 2026: help put things in place "so long as we don't change the actual
 * words"). A pad name is only tidied: the short forms GW's 40-character names use written out as GW writes them in
 * full ("S/E:" → "Stormcast Eternals:"), sizes as "(18ml)", "(English)" and "(Pb)" put right, small words lower case.
 *
 * The steps, each a short request so the Lair stays within Cloudflare's free plan (10 ms of computing, 50 outside calls
 * a request); the staff page drives them in turn and any staff page carries on where the last one stopped:
 *  1. POST /gw/pad: the pad's rows (the browser reads GW's xlsx), a part at a time. Each row is checked and tidied and
 *     kept in gw_pad. Shop fittings and lines with no NZ price are left out.
 *  2. POST /gw/shop: Shopify's Games Workshop variants, a few pages a request, into gw_shop. Library copies' SKUs are
 *     never GW codes, so they're never in it.
 *  3. POST /gw/plan: what changes (gw_plan): products to make, paint colours to add to their range's product, details
 *     to change, lines that stop selling at 0, and new paint colours held until they're released. GET /gw and
 *     GET /gw/plan show it.
 *  4. POST /gw/apply: the next few changes to Shopify. Each batch is claimed before it goes, so two pages never send it
 *     twice, and a batch Shopify never answered is looked for by SKU before anything is made again.
 *
 * New releases (GW's trade terms 9.3: nothing shown before GW reveals it, advance orders from 10am NZ on the pre-order
 * day, nothing to a customer before release day): a product released after today is made hidden (a draft) and goes on
 * sale at 10am on its pre-order day, a week before release unless staff change it on the tab; maintenance does that.
 * A new paint colour still to be released waits for a later pad, so it never shows early on its range's product. Round
 * 25's It's in email and parcels wait for release day too (src/gw-orders.js).
 *
 * Owner only: 'warhammer' isn't a permission a helper can be given. Methods of the Lair Durable Object (Object.assign
 * onto its prototype in lair.js).
 */
import { LairTime, RuleError, addDays } from './core.js';
import { shopifyPaceWait } from './shopify.js';

/** Every message staff see, word for word in the contract */
export const PAD_WORDS = {
  part: 'Send the pad a part at a time, in order. Pick the file again to start over.',
  tooMany: 'Send at most 200 rows a part.',
  noRows: "That file has no order pad lines the Lair can use. Pick GW's order pad (its Export sheet).",
  short: (n) => `That file has only ${n} order pad lines the Lair can use, so it doesn't look like GW's whole order pad. Pick the whole pad.`,
  noPad: 'Upload the order pad first.',
  noShop: "Check the shop first: the Lair hasn't read Shopify's Games Workshop products since the pad came in.",
  shopAgain: 'Check the shop again first: products have changed since the Lair last read it.',
  unfinished: 'Finish updating the shop first: some changes are still on their way to Shopify or the till. Carry on updating the shop, then add the new pad.',
  noPlan: 'Look over the plan first.',
  stale: 'A new pad came in since this plan was made. Check the shop again, then look over the new plan.',
  busy: 'Shopify is busy. Carrying on in a moment.',
  shopify: "Shopify didn't answer just now. Try again in a minute.",
  scopes: "Shopify said no: approve the Lair app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then carry on.",
  unconfirmed: "Shopify didn't confirm it was made after 3 tries.",
  setup: "The Lair isn't set up to add products yet: GW_LOCATION_ID and GW_POS_PUBLICATION_ID are missing.",
  noRelease: "That isn't one of the new releases waiting to go on sale.",
  onSaleDay: 'Pick a day from today up to the release day.',
};

/** GW product codes (the pad's Product Code, Shopify's SKU) */
const CODE = /^\d{8,13}$/;
/**
 * Rows a part (the staff page sends 60: tidying a row's name and keeping it takes about 0.05 ms, and a request on
 * Cloudflare's free plan has 10 ms), and the fewest lines a whole pad has (GW's has over 2,000)
 */
const PART_MAX = 200;
export const PAD_MIN_ROWS = 500;
/** Shopify pages a /gw/shop request reads (100 variants a page: more is too much work for one request on Cloudflare's free plan) */
export const SHOP_PAGES = 2;
/** Products a /gw/apply request changes or makes, paint colours it puts on a range's product (made, then added to) */
export const APPLY_BATCH = { update: 20, create: 5, rangeFirst: 25, rangeMore: 50, publish: 10 };
/** A batch with Shopify this long with no answer is looked for before it's sent again, up to FIND_MAX at a time (as many
    SKUs as one Shopify search takes: src/shopify.js gwFindSkus) */
export const STUCK_AFTER = 2 * 60_000;
export const FIND_MAX = 40;
/** Tries before a change is left as an error for staff to see */
const MOST_TRIES = 3;
/** A new release goes on sale at 10am NZ on its pre-order day, a week before release unless staff change it */
export const ON_SALE_DAYS = 7;
export const ON_SALE_HOUR = 10;
const TZ = 'Pacific/Auckland';
/** Pad categories that are shop fittings and displays, not stock */
const FITTINGS = /marketing pos|merchandising pos|fixtures and fittings|sales support/i;
/** The tag a release on the pad gets, and loses when the pad stops dating it (the plan, 31 Oct 2026) */
export const NEW_TAG = 'New release';

/* ---------------- the pad's names ---------------- */

/**
 * GW's short forms at the start of a name (or of a part after a colon), as GW writes them in full. The pad cuts names
 * at 40 characters, so "Stormcast Eternals:" comes as "S/E:".
 */
const SHORT_FORMS = {
  'L/I': 'Legions Imperialis', 'L/Imp': 'Legions Imperialis', 'L/Imperialis': 'Legions Imperialis', 'Legion Imperialis': 'Legions Imperialis',
  'L/A': 'Legiones Astartes', 'L/Ast': 'Legiones Astartes', 'L/Astartes': 'Legiones Astartes', 'Horus Heresy L/A': 'Horus Heresy Legiones Astartes',
  Hh: 'Horus Heresy', Thh: 'The Horus Heresy', 'Thh Saga': 'The Horus Heresy Saga', Sot: 'Siege of Terra', Mech: 'Mechanicum',
  Nec: 'Necromunda', 'Nec.': 'Necromunda', Necro: 'Necromunda',
  'M-E Sbg': 'Middle-earth SBG', 'M-E Sbg Journal': 'Middle-earth SBG Journal', 'Middle-Earth Sbg': 'Middle-earth SBG', Lotr: 'The Lord of the Rings',
  'Wh Underworlds': 'Warhammer Underworlds', Whu: 'Warhammer Underworlds', 'Whu Rivals Deck': 'Warhammer Underworlds Rivals Deck',
  'Wh Colour': 'Warhammer Colour', Wh40k: 'Warhammer 40,000', Aos: 'Age of Sigmar',
  'S/M': 'Space Marines', 'S/Marines': 'Space Marines', 'Chaos S/M': 'Chaos Space Marines', 'Chaos S/Marines': 'Chaos Space Marines', Csm: 'Chaos Space Marines',
  'A/S': 'Adepta Sororitas', 'A/Militarum': 'Astra Militarum', 'Ad/Mechanicus': 'Adeptus Mechanicus', 'Adept/Mechanicus': 'Adeptus Mechanicus',
  'D/A': 'Dark Angels', 'D/Angels': 'Dark Angels', 'D/G': 'Death Guard', 'D/Guard': 'Death Guard', 'G/K': 'Grey Knights', 'G/Knights': 'Grey Knights',
  'W/E': 'World Eaters',
  'Imp. Agents': 'Imperial Agents', 'Emperors Children': "Emperor's Children",
  'B/Z Fronteris': 'Battlezone Fronteris', 'B/Z Manuf.': 'Battlezone Manufactorum', 'B/Zone Manufact.': 'Battlezone Manufactorum',
  'K/T Datacards': 'Kill Team Datacards', 'K/Team Datacards': 'Kill Team Datacards', 'K/Team': 'Kill Team',
  'J/T': 'Journal Tactica', 'J/Tactica': 'Journal Tactica', 'A/Journal': 'Arcane Journal',
  'S/E': 'Stormcast Eternals', 'S/Eternals': 'Stormcast Eternals', 'S/G': 'Soulblight Gravelords', 'S/Gravelords': 'Soulblight Gravelords',
  'S/Blight': 'Soulblight Gravelords', 'Sblight Gravelrds': 'Soulblight Gravelords', 'S/B': 'Sons of Behemat', 'S/Auxilia': 'Solar Auxilia',
  'O/B': 'Ossiarch Bonereapers', 'O/Bonereapers': 'Ossiarch Bonereapers', 'O/W': 'Orruk Warclans', 'O/Warclans': 'Orruk Warclans',
  'G/Gitz': 'Gloomspite Gitz', 'Gloosmpite Gitz': 'Gloomspite Gitz', 'G/C': 'Grand Cathay', 'F-E Courts': 'Flesh-Eater Courts',
  'N/Haunt': 'Nighthaunt', 'I/Deepkin': 'Idoneth Deepkin', 'K/Overlords': 'Kharadron Overlords', 'H/Hashut': 'Helsmiths of Hashut',
  'C/O/S': 'Cities of Sigmar', 'C/S': 'Cities of Sigmar', 'Cities/Sigmar': 'Cities of Sigmar', 'Daughters/Khaine': 'Daughters of Khaine',
  'Disciples/Tzeentch': 'Disciples of Tzeentch', 'Lumineth R-L': 'Lumineth Realm-lords', Std: 'Slaves to Darkness', Sylv: 'Sylvaneth',
  'B/K': 'Blades of Khorne', Kob: 'Kingdom of Bretonnia', 'Kingdom/Bretonnia': 'Kingdom of Bretonnia', Tkk: 'Tomb Kings of Khemri',
  'O&G': 'Orc & Goblin Tribes', 'O&G Tribes': 'Orc & Goblin Tribes', 'Warriors O/Chaos': 'Warriors of Chaos',
  'Dwarf/M/H': 'Dwarfen Mountain Holds', 'Dwarfen M/H': 'Dwarfen Mountain Holds', 'Dwarfen M/Holds': 'Dwarfen Mountain Holds',
};
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const SHORT_LOOKUP = new Map(Object.entries(SHORT_FORMS).map(([k, v]) => [k.toLowerCase(), v]));
/** One pattern for them all, longest first, so "Chaos S/M" is found before anything shorter */
const SHORT_RE = new RegExp(`^(${Object.keys(SHORT_FORMS).sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?=\\s|$)`, 'i');

const SMALL = new Set(['of', 'the', 'and', 'in', 'on', 'to', 'for', 'a', 'an', 'with', 'at', 'from', 'by', 'or', 'vs']);
/** "Maggotkin Of Nurgle: The Glottkin" → "Maggotkin of Nurgle: The Glottkin": small words lower case, except a part's first */
function smallWords(text) {
  let start = true;
  return text.split(/(\s+)/).map((word) => {
    if (!word || /^\s+$/.test(word)) return word;
    const out = !start && SMALL.has(word.toLowerCase()) ? word.toLowerCase() : word;
    start = /[:(]$/.test(word);
    return out;
  }).join('');
}

/** The pad's size on a paint ("12Ml", "18Ml Row", "(24Ml)") as "12ml", or '' */
export function padSize(desc) {
  const found = String(desc || '').match(/(\d+)\s*Ml\b/i);
  return found ? `${found[1]}ml` : '';
}

/**
 * A pad line's name as a product name: GW's short forms written out, sizes as "(18ml)", "(English)", "(Uk/Row)" and
 * the like left off, "(Pb)" as "(Paperback)", "Of" and friends lower case. GW's words are never changed otherwise.
 */
export function padTitle(desc) {
  let text = String(desc ?? '').replace(/\s+/g, ' ').trim();
  // languages and markets: "(English)", "(Eng)", a cut-off "(Eng", "Eng" at the end, "Eng/Spa/Port/Lat", "(Uk/Row)"
  text = text
    .replace(/\s*\((?:English|Eng|Uk\/Row|Eu\/Au|Row)\)/gi, '')
    .replace(/\s*\((?:Eng|Engl|Engli|Englis)$/i, '')
    .replace(/\s+Eng(?:\/[A-Za-z]{2,5})+$/i, '')
    .replace(/\s+Eng$/i, '');
  // a colon always has a space after it ("Hh:Legion Astartes" → "Hh: Legion Astartes")
  text = text.replace(/\s*:\s*(?=\S)/g, ': ');
  // GW's short forms, at the start of each part
  text = text.split(': ').map((part) => part.replace(SHORT_RE, (found) => SHORT_LOOKUP.get(found.toLowerCase()) || found)).join(': ');
  text = text
    .replace(/\(Pb Omnibus\)/gi, '(Paperback Omnibus)')
    .replace(/\(Illus\.?\s*Hb\)/gi, '(Illustrated Hardback)')
    .replace(/\(A4 Hb\)/gi, '(A4 Hardback)')
    .replace(/\(Pb\)|\s+Pb$/gi, ' (Paperback)')
    .replace(/\(Hb\)|\s+Hb$/gi, ' (Hardback)')
    .replace(/\s+\(/g, ' (');
  // "O/T" and "W/" inside a name: "General O/T Empire", "Titan W/Melta Cannon"
  text = text.replace(/\bO\/T\b/g, 'of the').replace(/\bw\/\s*(?=[A-Za-z])/gi, 'with ');
  // sizes: "18Ml Row" and "(18Ml)" as "(18ml)", "15G" as "15g", "90Mm" as "90mm"
  text = text
    .replace(/\((\d+)\s*Ml\)/gi, '($1ml)')
    .replace(/\s+(\d+)\s*Ml(?:\s+Row)?\b/gi, ' ($1ml)')
    .replace(/\s+Row$/i, '')
    .replace(/\b(\d+)G\b/g, '$1g')
    .replace(/\b(\d+)Mm\b/g, '$1mm')
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, s) => `${n}${s.toLowerCase()}`);
  // letters the pad lower-cases that are capitals: "Gw", "Xl", "Sbg"
  text = text.replace(/\bWarhammer 40000\b/g, 'Warhammer 40,000').replace(/\bGw\b/g, 'GW').replace(/\bXl\b/g, 'XL').replace(/\bSbg\b/g, 'SBG').replace(/\bX(\d+)\b/g, 'x$1')
    .replace(/\bMk(i{1,3}|iv|vi{0,3}|ix|x)\b/gi, (m, n) => `Mk${n.toUpperCase()}`);
  return smallWords(text).replace(/\s+/g, ' ').trim();
}

/** The paint ranges sold as one product each, colours as variants (the plan, 31 Oct 2026: "One paint product per range") */
export const PAINT_RANGES = {
  'Paint - WH Colour - Base': { key: 'wh-colour-base', title: 'Warhammer Colour Base Paints' },
  'Paint - WH Colour - Layer': { key: 'wh-colour-layer', title: 'Warhammer Colour Layer Paints' },
  'Paint - WH Colour - Shade': { key: 'wh-colour-shade', title: 'Warhammer Colour Shade Paints' },
  'Paint - WH Colour - Contrast': { key: 'wh-colour-contrast', title: 'Warhammer Colour Contrast Paints' },
  'Paint - WH Colour - Dry': { key: 'wh-colour-dry', title: 'Warhammer Colour Dry Paints' },
  'Paint - WH Colour - Technical': { key: 'wh-colour-technical', title: 'Warhammer Colour Technical Paints' },
  'Paint - WH Colour - Air': { key: 'wh-colour-air', title: 'Warhammer Colour Air Paints' },
  'Paint - WH Pro - Tone': { key: 'wh-pro-tone', title: 'Warhammer Pro Tone Paints' },
};
export const RANGE_BY_KEY = Object.fromEntries(Object.values(PAINT_RANGES).map((r) => [r.key, r]));

/** A paint's colour in its range: the range's short form and the size left off ("B: Mephiston Red 12Ml Row" → "Mephiston Red") */
export function paintColour(desc, title = padTitle(desc)) {
  return title.replace(/^[^:]{1,20}:\s*/, '').replace(/\s*\(\d+ml\)\s*$/i, '').trim() || title;
}

/** A paint set with miniatures or tools: "Orks + Paints", "Aos Skaven + Paint Set", "40K Paints + Tools" */
const PAINT_SET = /\+\s*Paints?\b|\bPaints?\s*\+/i;
/** A starter box: a starter, introductory or core set, a Combat Patrol or a Spearhead */
const STARTER = /\b(?:Starter|Introductory|Core) Set\b|^(?:Spearhead|Combat Patrol):/i;

/**
 * Shopify's product type for a pad line, as the live GW listings have them: kits, sets and books War Game; paints,
 * paint sets, brushes, glue and tools Paints & Hobby; dice, cases and gaming accessories Dice & Accessories
 */
export function padType(row) {
  const system = String(row?.system || '');
  const race = String(row?.race || '');
  if (/^Hobby - Play\b/i.test(race)) return 'Dice & Accessories';
  if (/^(?:Paint|Hobby)$/i.test(system) || /^(?:Paint|Brush|Spray|Hobby)\b/i.test(race) || PAINT_SET.test(String(row?.desc || ''))) return 'Paints & Hobby';
  return 'War Game';
}

/** The game's tags, by the pad's System, as the live GW listings have them */
const GAME_TAGS = {
  'warhammer 40k': ['Warhammer 40K'], 'age of sigmar': ['Age of Sigmar'], 'kill team': ['Kill Team'], 'the horus heresy': ['Horus Heresy'],
  'the old world': ['The Old World'], necromunda: ['Necromunda'], 'legions imperialis': ['Legions Imperialis'], 'middle-earth': ['Middle-earth'],
  'blood bowl': ['Blood Bowl'], 'warhammer underworlds': ['Warhammer Underworlds'], 'chaos daemons': ['Chaos Daemons', 'Age of Sigmar', 'Warhammer 40K'],
  'adeptus titanicus': ['Adeptus Titanicus'], 'warhammer quest': ['Warhammer Quest'],
};
/** Games whose Race names a faction worth a tag (Blood Bowl's teams and Middle-earth's "Humans" aren't) */
const FACTION_GAMES = new Set(['warhammer 40k', 'age of sigmar', 'kill team', 'the horus heresy', 'necromunda', 'the old world']);
/** Race parts that aren't a faction: GW's grand alliances, and catch-alls */
const NOT_FACTIONS = new Set(['generic', 'other', 'order', 'chaos', 'death', 'destruction', 'imperium', 'xenos', 'knights', 'titans', 'loyalist legiones', 'traitor legiones', 'loyalist mechanicum']);
/** A faction as GW names it, where the pad's Race says it differently */
const FACTION_NAMES = {
  'emperors children': "Emperor's Children", 'death watch': 'Deathwatch', empire: 'Empire of Man', dwarf: 'Dwarfen Mountain Holds',
  'orcs and goblins': 'Orc & Goblin Tribes', 'high elves': 'High Elf Realms', 'wood elves': 'Wood Elf Realms', bretonnians: 'Kingdom of Bretonnia',
  'tomb kings': 'Tomb Kings of Khemri', beastmen: 'Beastmen Brayherds', 'lumineth realmlords': 'Lumineth Realm-lords',
};

/** A pad line's faction ("40K - Space Marines - Generic" → "Space Marines"), or null */
export function padFaction(row) {
  if (!FACTION_GAMES.has(String(row?.system || '').toLowerCase())) return null;
  const parts = String(row?.race || '').split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let pick = parts[parts.length - 1];
  if (pick.toLowerCase() === 'generic' && parts.length === 3) pick = parts[1];
  if (NOT_FACTIONS.has(pick.toLowerCase())) return null;
  return FACTION_NAMES[pick.toLowerCase()] || smallWords(pick);
}

/** A pad line's tags: Warhammer, its game, its faction or what kind of hobby item it is, and New release while it's dated */
export function padTags(row, title = padTitle(row?.desc)) {
  const tags = new Set(['Warhammer']);
  for (const tag of GAME_TAGS[String(row?.system || '').toLowerCase()] || []) tags.add(tag);
  const race = String(row?.race || '');
  const type = padType(row);
  const brand = /^Warhammer Pro\b/i.test(title) ? 'Warhammer Pro' : /^Warhammer Colour\b/i.test(title) ? 'Warhammer Colour' : null;
  if (PAINT_RANGES[race]) {
    tags.add('Citadel').add('Paints').add(/WH Pro/i.test(race) ? 'Warhammer Pro' : 'Warhammer Colour');
  } else if (/^Spray\b/i.test(race)) {
    tags.add('Citadel').add('Paints');
  } else if (PAINT_SET.test(String(row?.desc || ''))) {
    // a paint set with miniatures: its game and faction, as a kit has, and Citadel's paints
    const faction = padFaction(row);
    if (faction) tags.add(faction);
    tags.add('Citadel').add('Warhammer Colour');
  } else if (type === 'Paints & Hobby') {
    tags.add('Accessories').add('Citadel');
    if (brand) tags.add(brand);
  } else if (type === 'Dice & Accessories') {
    tags.add('Accessories');
  } else if (/^Black Library\b/i.test(race)) {
    tags.add('Black Library');
  } else {
    const faction = padFaction(row);
    if (faction) tags.add(faction);
  }
  if (STARTER.test(title)) tags.add('Starter sets');
  if (row?.release) tags.add(NEW_TAG);
  // a comma splits a tag in two in Shopify ("Warhammer 40,000" became "Warhammer 40" and "000")
  return [...tags].map((t) => t.replace(/,/g, '').trim()).filter(Boolean);
}

const cents = (value) => {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
const dollars = (c) => (Math.max(0, Number(c) || 0) / 100).toFixed(2);
/** A release date as the pad has it: a date, an ISO string, or an Excel day number (1 is 1 Jan 1900) */
export function dayKey(value) {
  const text = String(value ?? '').trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const n = Number(text);
  if (text && Number.isFinite(n) && n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  return '';
}

/** One pad row as the staff page sends it, checked and tidied; null when it isn't a line for sale */
export function cleanPadRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = String(raw.code ?? '').trim();
  const mrp = cents(raw.nz_mrp);
  if (!CODE.test(code) || !mrp) return null;
  const system = String(raw.system ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const race = String(raw.race ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (FITTINGS.test(`${system} ${race}`)) return null;
  const desc = String(raw.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!desc) return null;
  const range = PAINT_RANGES[race] || null;
  const barcode = String(raw.barcode ?? '').trim();
  const row = {
    code, desc, system, race, ss: String(raw.ss ?? '').trim().slice(0, 20),
    barcode: /^\d{8,14}$/.test(barcode) ? barcode : '',
    pack: Math.max(1, Math.min(100, Math.floor(Number(raw.pack) || 1))),
    trade: cents(raw.nz_trade), mrp, release: dayKey(raw.release),
    minStock: Math.max(0, Math.min(999, Math.floor(Number(raw.minstock) || 0))),
  };
  const title = padTitle(desc);
  return {
    ...row,
    title: title.slice(0, 255),
    type: padType(row),
    tags: padTags(row, title),
    rangeKey: range?.key || null,
    colour: range ? paintColour(desc, title).slice(0, 200) : null,
  };
}

/** The plain Google line every GW listing has (31 Oct 2026) */
export const seoLine = (title) => `Buy ${title} at Dice Goblin in Auckland, in store or ordered in from Games Workshop.`.slice(0, 320);
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const gid = (kind, id) => {
  const text = String(id ?? '').trim();
  if (!text) return null;
  return text.startsWith('gid://') ? text : `gid://shopify/${kind}/${text}`;
};

export const GW_PAD_TABLES = [
  `CREATE TABLE IF NOT EXISTS gw_pad (
    code TEXT PRIMARY KEY, desc TEXT NOT NULL, title TEXT NOT NULL, system TEXT, race TEXT, ss TEXT, barcode TEXT,
    pack INTEGER NOT NULL DEFAULT 1, trade INTEGER NOT NULL DEFAULT 0, mrp INTEGER NOT NULL, release TEXT,
    min_stock INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, tags TEXT NOT NULL, range_key TEXT, colour TEXT, part INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gw_shop (
    sku TEXT PRIMARY KEY, variant_id TEXT NOT NULL, product_id TEXT NOT NULL, product_title TEXT, status TEXT, variants INTEGER,
    price INTEGER, cost INTEGER, barcode TEXT, policy TEXT, pack INTEGER, release TEXT, new_tag INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS gw_plan (
    code TEXT PRIMARY KEY, action TEXT NOT NULL, title TEXT, range_key TEXT, changes TEXT, status TEXT NOT NULL DEFAULT 'todo',
    batch TEXT, sent_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, product_id TEXT, error TEXT, done_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS gw_plan_status ON gw_plan (status, action)',
  'CREATE TABLE IF NOT EXISTS gw_ranges (key TEXT PRIMARY KEY, product_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS gw_releases (
    code TEXT PRIMARY KEY, product_id TEXT NOT NULL, title TEXT NOT NULL, release TEXT NOT NULL, on_sale_at INTEGER NOT NULL,
    activated_at INTEGER, error TEXT, created_at INTEGER NOT NULL)`,
];

const meta = (lair, key) => {
  const value = lair.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value;
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};
const setMeta = (lair, key, value) => lair.write('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, JSON.stringify(value));
const int = (v) => Math.floor(Number(v) || 0);
const denied = (error) => /access denied|required access/i.test(String(error?.message || error || ''));
/** Shopify's trouble as words for staff: the permissions it needs, or try again */
const shopifyTrouble = (error) => new RuleError(denied(error) ? PAD_WORDS.scopes : PAD_WORDS.shopify, 503);
const problemText = (error) => (denied(error) ? PAD_WORDS.scopes : String(error?.message || error || 'Shopify said no.').replace(/^Shopify API: /, '').slice(0, 300));
const ORDER = "CASE action WHEN 'update' THEN 1 WHEN 'drop' THEN 2 WHEN 'create' THEN 3 ELSE 4 END";

export const gwPadMethods = {
  /** Auckland's day for `ms` */
  gwToday(ms = Date.now()) {
    return new LairTime(this.rulesCache?.tz || TZ).key(ms);
  },

  /** When a release goes on sale: 10am NZ on `day` (its pre-order day) */
  gwOnSaleAt(day) {
    return new LairTime(this.rulesCache?.tz || TZ).at(day, ON_SALE_HOUR * 60);
  },

  /** The shop's location and the till's sales channel (wrangler.toml), or a RuleError when they aren't set */
  gwIds() {
    const locationId = gid('Location', this.env.GW_LOCATION_ID);
    const posId = gid('Publication', this.env.GW_POS_PUBLICATION_ID);
    if (!locationId || !posId) throw new RuleError(PAD_WORDS.setup, 503);
    return { locationId, posId };
  },

  /**
   * POST /gw/pad { upload, date, part, parts, rows }: a part of the pad, in order. Part 1 starts a new pad (and clears
   * the last plan); its answer's upload goes with every other part. A part sent again is kept again. No awaits.
   */
  gwPadUpload(body, who) {
    this.requireStaff(who, 'warhammer');
    const part = int(body?.part);
    const parts = int(body?.parts);
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows || part < 1 || parts < part || parts > 50) throw new RuleError(PAD_WORDS.part);
    if (rows.length > PART_MAX) throw new RuleError(PAD_WORDS.tooMany, 413);
    const state = meta(this, 'gw-pad') || {};
    if (part > 1 && (!state.upload || body.upload !== state.upload || state.parts !== parts || (state.part !== part - 1 && state.part !== part))) {
      throw new RuleError(PAD_WORDS.part, 409);
    }
    // (the review, 31 Oct 2026) a new pad clears the plan, and with it what's still on its way to Shopify or the till:
    // made but not yet listed there, or not yet looked for. It waits for those.
    if (part === 1 && this.gwUnfinished()) throw new RuleError(PAD_WORDS.unfinished, 409);
    const upload = part === 1 ? crypto.randomUUID().slice(0, 8) : state.upload;
    if (part === 1) {
      this.write('DELETE FROM gw_pad');
      this.write('DELETE FROM gw_plan');
      this.write("DELETE FROM meta WHERE key = 'gw-plan'");
    }
    let stored = 0;
    for (const raw of rows) {
      const row = cleanPadRow(raw);
      if (!row) continue;
      this.write(
        `INSERT OR REPLACE INTO gw_pad (code, desc, title, system, race, ss, barcode, pack, trade, mrp, release, min_stock, type, tags, range_key, colour, part)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.code, row.desc, row.title, row.system, row.race, row.ss, row.barcode, row.pack, row.trade, row.mrp, row.release || null,
        row.minStock, row.type, JSON.stringify(row.tags), row.rangeKey, row.colour, part,
      );
      stored += 1;
    }
    const total = this.sql.exec('SELECT COUNT(*) AS n FROM gw_pad').one().n;
    const skipped = { ...(part === 1 ? {} : state.skipped || {}), [part]: rows.length - stored };
    const last = part === parts;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date || '')) ? body.date : this.gwToday();
    setMeta(this, 'gw-pad', {
      upload, date, part, parts, rows: total, skipped, at: part === 1 ? Date.now() : state.at, by: who.customerId || null,
      complete: last && total >= PAD_MIN_ROWS,
    });
    if (last && !total) throw new RuleError(PAD_WORDS.noRows, 422);
    if (last && total < PAD_MIN_ROWS) throw new RuleError(PAD_WORDS.short(total), 422);
    return { upload, stored, total, complete: last };
  },

  /**
   * POST /gw/shop { restart }: Shopify's Games Workshop variants, up to SHOP_PAGES pages a request, into gw_shop.
   * { done, count, wait (ms before asking again, while Shopify's bucket fills) }: call again until done.
   */
  async gwShopSync(body, who) {
    this.requireStaff(who, 'warhammer');
    const restart = Boolean(body?.restart);
    const before = meta(this, 'gw-shop') || {};
    if (restart && this.gwUnfinished()) throw new RuleError(PAD_WORDS.unfinished, 409);
    if (!restart && before.done) return { done: true, count: this.sql.exec('SELECT COUNT(*) AS n FROM gw_shop').one().n, wait: 0 };
    let cursor = restart ? null : before.cursor || null;
    const startedAt = restart || !before.startedAt ? Date.now() : before.startedAt;
    const pages = [];
    let wait = 0;
    for (let i = 0; i < SHOP_PAGES; i += 1) {
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await this.shopify.gwShopPage(cursor);
      } catch (error) {
        if (error?.throttled) {
          wait = shopifyPaceWait(error.cost) || 2000;
          break;
        }
        if (!pages.length) throw shopifyTrouble(error);
        break;
      }
      pages.push(page);
      cursor = page.next || null;
      if (!cursor) break;
      wait = shopifyPaceWait(this.shopify.lastCost);
      if (wait) break;
    }
    // --- no awaits from here on ---
    if (restart) this.write('DELETE FROM gw_shop');
    for (const page of pages) {
      for (const v of page.variants) {
        if (!CODE.test(String(v.sku || '').trim())) continue;
        this.write(
          `INSERT OR REPLACE INTO gw_shop (sku, variant_id, product_id, product_title, status, variants, price, cost, barcode, policy, pack, release, new_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          String(v.sku).trim(), v.id, v.productId, v.productTitle || null, v.status || null, Math.max(1, int(v.variants) || 1), cents(v.price),
          v.cost == null || v.cost === '' ? null : cents(v.cost), String(v.barcode || ''), v.policy || 'DENY', Math.max(1, int(v.pack) || 1),
          v.release || null, v.tags?.includes(NEW_TAG) ? 1 : 0,
        );
      }
    }
    const done = pages.length > 0 && !pages[pages.length - 1].next;
    setMeta(this, 'gw-shop', { cursor: done ? null : cursor, done, startedAt, at: Date.now() });
    return { done, count: this.sql.exec('SELECT COUNT(*) AS n FROM gw_shop').one().n, wait: done ? 0 : wait };
  },

  /**
   * Whether a change is still on its way: with Shopify (or not yet looked for), or made but not yet on the till. A new
   * pad, reading the shop again and a new plan all wait for these (the reviews, 31 Oct 2026). No awaits.
   */
  gwUnfinished() {
    return this.sql.exec("SELECT COUNT(*) AS n FROM gw_plan WHERE status IN ('sending', 'publish')").one().n > 0;
  },

  /** Whether a batch is with Shopify now (claimed less than STUCK_AFTER ago). No awaits. */
  gwSending(now) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM gw_plan WHERE status = 'sending' AND sent_at >= ?", now - STUCK_AFTER).one().n > 0;
  },

  /** POST /gw/plan: what the pad changes in the shop (see the top of this file). No awaits. */
  gwPlan(who) {
    this.requireStaff(who, 'warhammer');
    const pad = meta(this, 'gw-pad');
    if (!pad?.complete) throw new RuleError(PAD_WORDS.noPad, 409);
    // changes still on their way come first: until they're done the shop can't be read again either
    if (this.gwUnfinished()) throw new RuleError(PAD_WORDS.unfinished, 409);
    const shop = meta(this, 'gw-shop');
    if (!shop?.done || !(shop.startedAt > pad.at)) throw new RuleError(PAD_WORDS.noShop, 409);
    const applied = meta(this, 'gw-applied');
    if (applied && !(shop.startedAt > applied)) throw new RuleError(PAD_WORDS.shopAgain, 409);
    const today = this.gwToday();
    this.write('DELETE FROM gw_plan');
    // new: on the pad, not in the shop. A paint colour goes on its range's product, once it's released.
    this.write(
      `INSERT INTO gw_plan (code, action, title, range_key)
       SELECT p.code, CASE WHEN p.range_key IS NULL THEN 'create' WHEN p.release IS NOT NULL AND p.release > ? THEN 'later' ELSE 'range' END,
         COALESCE(p.colour, p.title), p.range_key
       FROM gw_pad p LEFT JOIN gw_shop s ON s.sku = p.code WHERE s.sku IS NULL`,
      today,
    );
    // in both: what's different. A product's own details (its release date and New release tag) only on a product of
    // its own: a paint range's product is shared by its colours.
    // (SQLite picks out the ones with a difference, so a pad of 2,000 lines already in the shop stays quick)
    const both = this.sql.exec(
      `SELECT p.code, p.title, p.mrp, p.trade, p.barcode, p.pack, p.release, s.variant_id, s.product_id, s.product_title, s.variants,
         s.price, s.cost, s.barcode AS shop_barcode, s.policy, s.pack AS shop_pack, s.release AS shop_release, s.new_tag
       FROM gw_pad p JOIN gw_shop s ON s.sku = p.code
       WHERE s.price IS NOT p.mrp OR (p.trade > 0 AND s.cost IS NOT p.trade) OR (p.barcode != '' AND s.barcode IS NOT p.barcode)
         OR COALESCE(s.pack, 1) != p.pack OR s.policy IS NOT 'CONTINUE'
         OR (COALESCE(s.variants, 1) = 1 AND ((p.release IS NOT NULL AND s.release IS NOT p.release) OR s.new_tag != (p.release IS NOT NULL)))`,
    ).toArray();
    for (const r of both) {
      const changes = {};
      if (r.price !== r.mrp) changes.price = [r.price, r.mrp];
      if (r.trade && r.cost !== r.trade) changes.cost = [r.cost, r.trade];
      if (r.barcode && r.shop_barcode !== r.barcode) changes.barcode = [r.shop_barcode || '', r.barcode];
      if ((r.shop_pack || 1) !== r.pack) changes.pack = [r.shop_pack || 1, r.pack];
      if (r.policy !== 'CONTINUE') changes.policy = [r.policy, 'CONTINUE'];
      if ((r.variants || 1) === 1) {
        if (r.release && r.shop_release !== r.release) changes.release = [r.shop_release || '', r.release];
        if (Boolean(r.new_tag) !== Boolean(r.release)) changes.newTag = [Boolean(r.new_tag), Boolean(r.release)];
      }
      if (!Object.keys(changes).length) continue;
      this.write('INSERT INTO gw_plan (code, action, title, changes) VALUES (?, ?, ?, ?)', r.code, 'update', r.product_title || r.title,
        JSON.stringify({ ...changes, variantId: r.variant_id, productId: r.product_id }));
    }
    // off the pad and still selling at 0: it stops at 0 (what's on the shelf still sells)
    this.write(
      `INSERT INTO gw_plan (code, action, title, changes)
       SELECT s.sku, 'drop', s.product_title, json_object('variantId', s.variant_id, 'productId', s.product_id)
       FROM gw_shop s LEFT JOIN gw_pad p ON p.code = s.sku WHERE p.code IS NULL AND s.policy = 'CONTINUE'`,
    );
    // (the review, 31 Oct 2026) a hidden release GW has moved: its on-sale day moves with it (a week before the new release
    // day, as when it was made), so it never goes on sale at the old pre-order day. Today's on the Lair's own record, so
    // it follows GW's latest pad whether or not this plan is applied.
    const moved = this.sql.exec(
      `SELECT g.code, p.release FROM gw_releases g JOIN gw_pad p ON p.code = g.code
       WHERE g.activated_at IS NULL AND p.release IS NOT NULL AND p.release != g.release`,
    ).toArray();
    for (const r of moved) {
      this.write('UPDATE gw_releases SET release = ?, on_sale_at = ?, error = NULL WHERE code = ?', r.release, this.gwOnSaleAt(addDays(r.release, -ON_SALE_DAYS)), r.code);
    }
    setMeta(this, 'gw-plan', { at: Date.now(), upload: pad.upload, date: pad.date });
    return this.gwPlanSummary();
  },

  /** Where things stand: the pad, the shop, the plan's counts, the paint ranges and the releases waiting. No awaits. */
  gwPlanSummary() {
    const counts = {};
    for (const r of this.sql.exec('SELECT action, status, COUNT(*) AS n FROM gw_plan GROUP BY action, status').toArray()) {
      counts[r.action] = counts[r.action] || { todo: 0, sending: 0, publish: 0, done: 0, error: 0 };
      counts[r.action][r.status] = r.n;
    }
    const made = new Set(this.sql.exec('SELECT key FROM gw_ranges').toArray().map((r) => r.key));
    const ranges = this.sql.exec(
      "SELECT range_key AS key, COUNT(*) AS colours, SUM(status = 'done') AS done FROM gw_plan WHERE action = 'range' GROUP BY range_key ORDER BY range_key",
    ).toArray().map((r) => ({ key: r.key, title: RANGE_BY_KEY[r.key]?.title || r.key, colours: r.colours, done: r.done || 0, made: made.has(r.key) }));
    const releases = this.sql.exec('SELECT * FROM gw_releases WHERE activated_at IS NULL ORDER BY on_sale_at, title LIMIT 50').toArray()
      .map((r) => ({ code: r.code, title: r.title, release: r.release, onSaleAt: r.on_sale_at, onSale: this.gwToday(r.on_sale_at), error: r.error || null }));
    const left = this.sql.exec("SELECT COUNT(*) AS n FROM gw_plan WHERE status IN ('todo', 'sending', 'publish') AND action != 'later'").one().n;
    return { pad: meta(this, 'gw-pad'), shop: meta(this, 'gw-shop'), plan: meta(this, 'gw-plan'), counts, ranges, releases, left };
  },

  /** GET /gw: where things stand. GET /gw/plan?action=create|range|later|update|drop&page=: the plan's lines, 50 a page. No awaits. */
  gwPlanView(url, who) {
    this.requireStaff(who, 'warhammer');
    const asked = url.searchParams.get('action');
    const action = ['create', 'range', 'later', 'update', 'drop'].includes(asked) ? asked : null;
    const page = Math.max(1, Math.min(200, int(url.searchParams.get('page')) || 1));
    const rows = action
      ? this.sql.exec(
        `SELECT g.code, g.action, g.title, g.range_key, g.changes, g.status, g.error, p.mrp, p.system, p.release, p.type
         FROM gw_plan g LEFT JOIN gw_pad p ON p.code = g.code WHERE g.action = ?
         ORDER BY g.status = 'error' DESC, COALESCE(g.range_key, ''), g.title LIMIT 51 OFFSET ?`,
        action, (page - 1) * 50,
      ).toArray()
      : [];
    return {
      ...this.gwPlanSummary(),
      page,
      more: rows.length > 50,
      lines: rows.slice(0, 50).map((r) => ({
        code: r.code, action: r.action, title: r.title, range: r.range_key ? RANGE_BY_KEY[r.range_key]?.title || r.range_key : null,
        price: r.mrp ?? null, game: r.system || null, type: r.type || null, release: r.release || null, status: r.status, error: r.error || null,
        changes: r.changes ? Object.fromEntries(Object.entries(JSON.parse(r.changes)).filter(([k]) => !/Id$/.test(k))) : null,
      })),
    };
  },

  /**
   * POST /gw/apply: the next batch into Shopify (see the top of this file). First a batch Shopify never answered, then
   * products made but not yet on the till, then updates and stops (20 products), new products (5), paint colours (a
   * range's product made with 25, then 50 at a time). { done (this request), left, errors (this request's), wait (ms
   * before carrying on, while Shopify's busy), busy (words for that), summary }.
   */
  async gwApply(who) {
    this.requireStaff(who, 'warhammer');
    const plan = meta(this, 'gw-plan');
    const pad = meta(this, 'gw-pad');
    if (!plan) throw new RuleError(PAD_WORDS.noPlan, 409);
    if (!pad?.complete || plan.upload !== pad.upload) throw new RuleError(PAD_WORDS.stale, 409);
    const ids = this.gwIds();
    const now = Date.now();
    const stuck = this.sql.exec("SELECT * FROM gw_plan WHERE status = 'sending' AND sent_at < ? ORDER BY sent_at LIMIT ?", now - STUCK_AFTER, FIND_MAX).toArray();
    if (stuck.length) return this.gwResolve(stuck);
    const unpublished = this.sql.exec("SELECT DISTINCT product_id FROM gw_plan WHERE status = 'publish' AND product_id IS NOT NULL LIMIT ?", APPLY_BATCH.publish).toArray();
    if (unpublished.length) return this.gwPublishMade(unpublished.map((r) => r.product_id), ids);
    const next = this.sql.exec(`SELECT action FROM gw_plan WHERE status = 'todo' AND action != 'later' ORDER BY ${ORDER} LIMIT 1`).toArray()[0];
    if (!next) {
      // only batches still with Shopify: wait for them
      return this.gwSending(now) ? { ...this.gwApplied(0, [], 5000), busy: PAD_WORDS.busy } : this.gwApplied(0, []);
    }
    if (next.action === 'update' || next.action === 'drop') return this.gwApplyUpdates(now);
    if (next.action === 'create') return this.gwApplyCreates(now, ids);
    return this.gwApplyRange(now, ids);
  },

  /** An apply's answer. No awaits. */
  gwApplied(done, errors, wait = 0) {
    const summary = this.gwPlanSummary();
    return { done, left: summary.left, errors, wait, summary };
  },

  /** Claim rows for a batch: they're with Shopify from now (and the shop's changed: a new plan needs a fresh read). No awaits. */
  gwClaim(codes, now) {
    const batch = crypto.randomUUID().slice(0, 8);
    for (const code of codes) this.write("UPDATE gw_plan SET status = 'sending', batch = ?, sent_at = ? WHERE code = ? AND status = 'todo'", batch, now, code);
    setMeta(this, 'gw-applied', now);
    return batch;
  },

  /** A batch put back on the list untried (Shopify's bucket was empty, so nothing ran). No awaits. */
  gwRelease(batch, wait) {
    this.write("UPDATE gw_plan SET status = 'todo', batch = NULL WHERE batch = ? AND status = 'sending'", batch);
    return { ...this.gwApplied(0, [], wait), busy: PAD_WORDS.busy };
  },

  /**
   * A batch's rows after Shopify answered: done (or made but not yet on the till), tried again (a change Shopify made
   * no part of, up to MOST_TRIES), left as an error, or left with Shopify (unknown: looked for by SKU later). `results`
   * is [{ codes, error, nothingRan, unknown, productId, published }]. No awaits.
   */
  gwSettleBatch(batch, results, now) {
    let done = 0;
    const errors = [];
    for (const r of results) {
      // Shopify didn't say whether it made it: the batch stays claimed, and is looked for by SKU in a while
      if (r.unknown) continue;
      for (const code of r.codes) {
        const row = this.sql.exec('SELECT * FROM gw_plan WHERE code = ? AND batch = ?', code, batch).toArray()[0];
        if (!row || row.status !== 'sending') continue;
        if (!r.error) {
          const status = r.productId && r.published === false ? 'publish' : 'done';
          this.write('UPDATE gw_plan SET status = ?, product_id = COALESCE(?, product_id), error = NULL, done_at = ? WHERE code = ?', status, r.productId || null, now, code);
          if (status === 'done') done += 1;
          continue;
        }
        const tries = row.tries + 1;
        const text = problemText(r.error);
        const giveUp = !r.nothingRan || tries >= MOST_TRIES || denied(r.error);
        this.write('UPDATE gw_plan SET status = ?, tries = ?, error = ?, batch = NULL WHERE code = ?', giveUp ? 'error' : 'todo', tries, text, code);
        if (giveUp) errors.push({ code, title: row.title, error: text });
      }
    }
    return { done, errors };
  },

  /** Updates and stops, up to APPLY_BATCH.update products: prices, costs, barcodes, packs, keep or stop selling at 0, dates, tags */
  async gwApplyUpdates(now) {
    const rows = this.sql.exec(
      `SELECT g.code, g.action, g.changes, p.mrp, p.trade, p.barcode, p.pack, p.release FROM gw_plan g LEFT JOIN gw_pad p ON p.code = g.code
       WHERE g.status = 'todo' AND g.action IN ('update', 'drop') ORDER BY g.action DESC, g.code LIMIT 100`,
    ).toArray();
    const groups = new Map();
    for (const row of rows) {
      const c = JSON.parse(row.changes || '{}');
      if (!c.productId || !c.variantId) continue;
      if (!groups.has(c.productId) && groups.size >= APPLY_BATCH.update) continue;
      const group = groups.get(c.productId) || { productId: c.productId, variants: [], codes: [], tag: null, release: null };
      const input = { id: c.variantId };
      if (row.action === 'drop') input.inventoryPolicy = 'DENY';
      else {
        if (c.price) input.price = dollars(row.mrp);
        if (c.cost) input.inventoryItem = { cost: dollars(row.trade) };
        if (c.barcode) input.barcode = row.barcode;
        if (c.policy) input.inventoryPolicy = 'CONTINUE';
        if (c.pack) input.metafields = [{ namespace: 'custom', key: 'gw_pack_size', type: 'number_integer', value: String(row.pack) }];
        if (c.release) group.release = row.release;
        if (c.newTag) group.tag = c.newTag[1] ? 'add' : 'remove';
      }
      if (Object.keys(input).length > 1) group.variants.push(input);
      group.codes.push(row.code);
      groups.set(c.productId, group);
    }
    const list = [...groups.values()];
    if (!list.length) return this.gwApplied(0, []);
    const batch = this.gwClaim(list.flatMap((g) => g.codes), now);
    let results;
    try {
      results = await this.shopify.gwUpdate(list);
    } catch (error) {
      if (error?.throttled) return this.gwRelease(batch, shopifyPaceWait(error.cost) || 2000);
      // the answer was lost or refused: updates are safe to send again, so they go back on the list (a few times)
      results = list.map((g) => ({ productId: g.productId, error }));
    }
    // --- no awaits from here on ---
    const byProduct = new Map(results.map((r) => [r.productId, r]));
    const settled = this.gwSettleBatch(batch, list.map((g) => {
      const r = byProduct.get(g.productId) || { error: new Error('Shopify gave no answer for it.') };
      return { codes: g.codes, ...(r.error ? { error: r.error, nothingRan: true } : {}) };
    }), Date.now());
    return this.gwApplied(settled.done, settled.errors);
  },

  /** New products, APPLY_BATCH.create at a time, made on the till only (and hidden, for a release still to come) */
  async gwApplyCreates(now, ids) {
    const rows = this.sql.exec(
      `SELECT p.* FROM gw_plan g JOIN gw_pad p ON p.code = g.code WHERE g.status = 'todo' AND g.action = 'create'
       ORDER BY p.system, p.title LIMIT ?`,
      APPLY_BATCH.create,
    ).toArray();
    const products = rows.map((p) => ({ codes: [p.code], ...this.gwProductInput(p, ids, now) }));
    const batch = this.gwClaim(rows.map((p) => p.code), now);
    let results;
    try {
      results = await this.shopify.gwCreate(products, ids.posId);
    } catch (error) {
      if (error?.throttled) return this.gwRelease(batch, shopifyPaceWait(error.cost) || 2000);
      // refused before it ran: back on the list; otherwise the batch stays claimed and is looked for by SKU in a while
      if (error?.nothingRan) {
        const settled = this.gwSettleBatch(batch, products.map((p) => ({ codes: p.codes, error, nothingRan: true })), Date.now());
        return this.gwApplied(0, settled.errors);
      }
      // the rest carry on meanwhile
      return { ...this.gwApplied(0, [], 1000), busy: PAD_WORDS.busy };
    }
    // --- no awaits from here on ---
    const later = Date.now();
    for (const r of results) {
      const p = rows.find((x) => x.code === r.codes[0]);
      if (!r.error && r.productId && p) this.gwKeepRelease(p, r.productId, now);
    }
    const settled = this.gwSettleBatch(batch, results, later);
    return this.gwApplied(settled.done, settled.errors);
  },

  /** A paint range's colours: its product made with the first APPLY_BATCH.rangeFirst, then APPLY_BATCH.rangeMore at a time */
  async gwApplyRange(now, ids) {
    // a range with a batch on its way waits for it, so its product is never made twice
    const key = this.sql.exec(
      `SELECT range_key FROM gw_plan WHERE status = 'todo' AND action = 'range'
       AND range_key NOT IN (SELECT range_key FROM gw_plan WHERE status IN ('sending', 'publish') AND action = 'range')
       ORDER BY range_key LIMIT 1`,
    ).toArray()[0]?.range_key;
    if (!key) return { ...this.gwApplied(0, [], 5000), busy: PAD_WORDS.busy };
    const existing = this.sql.exec('SELECT product_id FROM gw_ranges WHERE key = ?', key).toArray()[0]?.product_id || null;
    const rows = this.sql.exec(
      `SELECT p.* FROM gw_plan g JOIN gw_pad p ON p.code = g.code WHERE g.status = 'todo' AND g.action = 'range' AND g.range_key = ?
       ORDER BY p.colour, p.code LIMIT ?`,
      key, existing ? APPLY_BATCH.rangeMore : APPLY_BATCH.rangeFirst,
    ).toArray();
    const names = this.gwColourNames(key);
    const codes = rows.map((p) => p.code);
    const variants = rows.map((p) => this.gwVariantInput(p, ids, 'Colours', names.get(p.code) || p.colour));
    const batch = this.gwClaim(codes, now);
    let results;
    try {
      results = existing
        ? await this.shopify.gwAddVariants(existing, variants)
        : await this.shopify.gwCreate([{ codes, range: key, input: this.gwRangeInput(key, variants) }], ids.posId);
    } catch (error) {
      if (error?.throttled) return this.gwRelease(batch, shopifyPaceWait(error.cost) || 2000);
      if (error?.nothingRan) {
        const settled = this.gwSettleBatch(batch, [{ codes, error, nothingRan: true }], Date.now());
        return this.gwApplied(0, settled.errors);
      }
      return { ...this.gwApplied(0, [], 1000), busy: PAD_WORDS.busy };
    }
    // --- no awaits from here on ---
    const later = Date.now();
    for (const r of results) {
      if (!existing && r.productId && !r.error) {
        this.write('INSERT OR IGNORE INTO gw_ranges (key, product_id, title, created_at) VALUES (?, ?, ?, ?)', key, r.productId, RANGE_BY_KEY[key]?.title || key, later);
      }
    }
    const settled = this.gwSettleBatch(batch, results, later);
    return this.gwApplied(settled.done, settled.errors);
  },

  /**
   * A batch Shopify never answered: new products and colours are looked for by SKU (found: made, so they only need to
   * be on the till; not found: back on the list, up to MOST_TRIES), and updates go back on the list (safe to send again).
   */
  async gwResolve(stuck) {
    const making = stuck.filter((r) => r.action === 'create' || r.action === 'range');
    let found = new Map();
    if (making.length) {
      try {
        found = await this.shopify.gwFindSkus(making.map((r) => r.code));
      } catch (error) {
        if (error?.throttled) return { ...this.gwApplied(0, [], shopifyPaceWait(error.cost) || 2000), busy: PAD_WORDS.busy };
        throw shopifyTrouble(error);
      }
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const errors = [];
    for (const row of stuck) {
      const fresh = this.sql.exec('SELECT status, batch, tries FROM gw_plan WHERE code = ?', row.code).toArray()[0];
      if (!fresh || fresh.status !== 'sending' || fresh.batch !== row.batch) continue;
      const hit = found.get(row.code);
      if (hit) {
        this.write("UPDATE gw_plan SET status = 'publish', product_id = ?, error = NULL WHERE code = ?", hit.productId, row.code);
        // (the review, 31 Oct 2026) a release still to come was made hidden: it still goes on sale on its pre-order day
        if (row.action === 'create') {
          const p = this.sql.exec('SELECT * FROM gw_pad WHERE code = ?', row.code).toArray()[0];
          if (p) this.gwKeepRelease(p, hit.productId, row.sent_at);
        }
        if (row.action === 'range' && row.range_key) {
          this.write('INSERT OR IGNORE INTO gw_ranges (key, product_id, title, created_at) VALUES (?, ?, ?, ?)', row.range_key, hit.productId, RANGE_BY_KEY[row.range_key]?.title || row.range_key, now);
        }
      } else if (fresh.tries + 1 >= MOST_TRIES && (row.action === 'create' || row.action === 'range')) {
        this.write("UPDATE gw_plan SET status = 'error', tries = tries + 1, error = ?, batch = NULL WHERE code = ?", PAD_WORDS.unconfirmed, row.code);
        errors.push({ code: row.code, title: row.title, error: PAD_WORDS.unconfirmed });
      } else {
        this.write("UPDATE gw_plan SET status = 'todo', batch = NULL, tries = tries + 1 WHERE code = ?", row.code);
      }
    }
    return this.gwApplied(0, errors);
  },

  /** Products made whose till listing didn't go through: on the till now (publishing twice changes nothing) */
  async gwPublishMade(productIds, ids) {
    let results;
    try {
      results = await this.shopify.gwPublish(productIds, ids.posId);
    } catch (error) {
      if (error?.throttled) return { ...this.gwApplied(0, [], shopifyPaceWait(error.cost) || 2000), busy: PAD_WORDS.busy };
      throw shopifyTrouble(error);
    }
    // --- no awaits from here on ---
    let done = 0;
    const errors = [];
    const now = Date.now();
    for (const r of results) {
      const rows = this.sql.exec("SELECT code, title, tries FROM gw_plan WHERE product_id = ? AND status = 'publish'", r.productId).toArray();
      for (const row of rows) {
        if (!r.error) {
          this.write("UPDATE gw_plan SET status = 'done', error = NULL, done_at = ? WHERE code = ?", now, row.code);
          done += 1;
        } else if (row.tries + 1 >= MOST_TRIES || denied(r.error)) {
          this.write("UPDATE gw_plan SET status = 'error', tries = tries + 1, error = ? WHERE code = ?", problemText(r.error), row.code);
          errors.push({ code: row.code, title: row.title, error: problemText(r.error) });
        } else {
          this.write('UPDATE gw_plan SET tries = tries + 1, error = ? WHERE code = ?', problemText(r.error), row.code);
        }
      }
    }
    return this.gwApplied(done, errors);
  },

  /** Each colour's name on its range's product: its colour, with its size when the range has more than one size. No awaits. */
  gwColourNames(key) {
    const colours = this.sql.exec('SELECT code, desc, colour FROM gw_pad WHERE range_key = ? ORDER BY colour, code', key).toArray();
    const sizes = new Set(colours.map((c) => padSize(c.desc)).filter(Boolean));
    const names = new Map();
    const taken = new Set();
    for (const c of colours) {
      const size = padSize(c.desc);
      let name = sizes.size > 1 && size ? `${c.colour} (${size})` : c.colour;
      if (taken.has(name.toLowerCase())) name = `${name} (${c.code})`;
      taken.add(name.toLowerCase());
      names.set(c.code, name);
    }
    return names;
  },

  /** A variant for productSet: selling at 0 (ordered in), none in stock at the shop, its pack when GW sells it in more than 1s */
  gwVariantInput(p, ids, optionName, optionValue) {
    return {
      optionValues: [{ optionName, name: optionValue }],
      sku: p.code,
      ...(p.barcode ? { barcode: p.barcode } : {}),
      price: dollars(p.mrp),
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: true, ...(p.trade ? { cost: dollars(p.trade) } : {}) },
      inventoryQuantities: [{ locationId: ids.locationId, name: 'available', quantity: 0 }],
      ...(p.pack > 1 ? { metafields: [{ namespace: 'custom', key: 'gw_pack_size', type: 'number_integer', value: String(p.pack) }] } : {}),
    };
  },

  /**
   * Whether a pad line made at `madeAt` is made hidden (a release still to come, before its pre-order day) and when it
   * goes on sale: { draft, onSaleAt }. No awaits.
   */
  gwReleaseOf(p, madeAt) {
    const future = Boolean(p.release && p.release > this.gwToday(madeAt));
    const onSaleAt = future ? this.gwOnSaleAt(addDays(p.release, -ON_SALE_DAYS)) : null;
    return { draft: future && onSaleAt > madeAt, onSaleAt };
  },

  /** A product made hidden, kept to go on sale on its pre-order day (maintenance: gwActivateReleases). No awaits. */
  gwKeepRelease(p, productId, madeAt) {
    const { draft, onSaleAt } = this.gwReleaseOf(p, madeAt);
    if (!draft) return;
    // (the second review, 31 Oct 2026) one made again (the last was deleted in Shopify) replaces it; the same product
    // recorded twice keeps its row, and a day staff chose
    this.write(
      `INSERT INTO gw_releases (code, product_id, title, release, on_sale_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET product_id = excluded.product_id, title = excluded.title, release = excluded.release,
         on_sale_at = excluded.on_sale_at, activated_at = NULL, error = NULL, created_at = excluded.created_at
       WHERE gw_releases.product_id != excluded.product_id`,
      p.code, productId, p.title, p.release, onSaleAt, Date.now(),
    );
  },

  /**
   * A pad line as its own product: { input (productSet's), draft, onSaleAt }. On the till only until it has GW's picture;
   * a release still to come is a draft until 10am on its pre-order day (on sale now when that's passed).
   */
  gwProductInput(p, ids, now = Date.now()) {
    const { draft, onSaleAt } = this.gwReleaseOf(p, now);
    let tags = [];
    try {
      tags = JSON.parse(p.tags || '[]');
    } catch {
      tags = [];
    }
    return {
      draft,
      onSaleAt,
      input: {
        title: p.title,
        vendor: 'Games Workshop',
        productType: p.type || 'War Game',
        tags,
        status: draft ? 'DRAFT' : 'ACTIVE',
        descriptionHtml: `<p>${escapeHtml(p.title)}</p>`,
        seo: { description: seoLine(p.title) },
        ...(p.release ? { metafields: [{ namespace: 'custom', key: 'gw_release_date', type: 'date', value: p.release }] } : {}),
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [this.gwVariantInput(p, ids, 'Title', 'Default Title')],
      },
    };
  },

  /** A paint range as one product, a variant a colour (productSet), with its first colours */
  gwRangeInput(key, variants) {
    const range = RANGE_BY_KEY[key];
    return {
      title: range.title,
      vendor: 'Games Workshop',
      productType: 'Paints & Hobby',
      tags: ['Warhammer', 'Citadel', 'Paints', key.startsWith('wh-pro') ? 'Warhammer Pro' : 'Warhammer Colour'],
      status: 'ACTIVE',
      descriptionHtml: `<p>${escapeHtml(range.title)}</p>`,
      seo: { description: seoLine(range.title) },
      productOptions: [{ name: 'Colours', values: variants.map((v) => ({ name: v.optionValues[0].name })) }],
      variants,
    };
  },

  /**
   * POST /gw/releases/:code { onSale: 'YYYY-MM-DD' }: the day a release still hidden goes on sale (10am NZ), from today
   * up to its release day. No awaits.
   */
  gwReleaseDay(code, body, who) {
    this.requireStaff(who, 'warhammer');
    const row = this.sql.exec('SELECT * FROM gw_releases WHERE code = ? AND activated_at IS NULL', String(code || '')).toArray()[0];
    if (!row) throw new RuleError(PAD_WORDS.noRelease, 404);
    const day = String(body?.onSale || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > row.release || day < this.gwToday()) throw new RuleError(PAD_WORDS.onSaleDay);
    this.write('UPDATE gw_releases SET on_sale_at = ?, error = NULL WHERE code = ?', this.gwOnSaleAt(day), row.code);
    return this.gwPlanSummary();
  },

  /** Maintenance: releases whose pre-order time has come go on sale (their draft made active), up to 10 a run */
  async gwActivateReleases(now = Date.now()) {
    const due = this.sql.exec('SELECT * FROM gw_releases WHERE activated_at IS NULL AND on_sale_at <= ? ORDER BY on_sale_at LIMIT 10', now).toArray();
    if (!due.length) return null;
    const results = await this.shopify.gwActivate(due.map((r) => r.product_id));
    // --- no awaits from here on ---
    const byProduct = new Map(results.map((r) => [r.productId, r]));
    const activated = [];
    for (const row of due) {
      const r = byProduct.get(row.product_id);
      if (r && !r.error) {
        this.write('UPDATE gw_releases SET activated_at = ?, error = NULL WHERE code = ? AND activated_at IS NULL', Date.now(), row.code);
        activated.push(row.title);
      } else {
        this.write('UPDATE gw_releases SET error = ? WHERE code = ?', problemText(r?.error || 'Shopify said no.'), row.code);
      }
    }
    return activated.length ? { activated } : null;
  },
};

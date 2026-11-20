/**
 * Round 48 (21 Nov 2026, contract v48-delivery): delivery priced from the parcel and the address.
 *
 * Mo, 21 Nov 2026: a rural parcel cost him $16 when the customer had paid the flat $10, because rural was an option the
 * customer chose. "Can we make it that when they say proceed to pay it leads then to a 'lair' and it shows and
 * calculates the delivery fee and give them the real number but use only aramex ... maybe add $1 extra on every order
 * for the package and wrap cost." One consistent rule: every posted order is priced as an Aramex parcel from the Lair,
 * whoever sends it (dropshipped dice and Baron of Dice included).
 *
 * The price is what GoSweetSpot (his courier account) quotes for Aramex to that address, with GST, plus DELIVERY.pack
 * for the box and wrap. Rural is the courier's call from the address, never the customer's. When there's no live
 * price (no key, GoSweetSpot down, no Aramex service), the old flat rates stand: nobody is ever stopped from buying.
 *
 * This file is the rule, the call to GoSweetSpot, and POST /delivery/quote (deliveryMethods, on the Lair). It changes
 * nothing in Shopify; the last live quote's workings go to the config database's status table (key delivery).
 */
import { recordStatus } from './config.js';
import { RuleError } from './core.js';

/** The numbers in one place */
export const DELIVERY = Object.freeze({
  carrier: 'aramex',
  /** the box and wrap, in cents, on every posted order (Mo, 21 Nov 2026) */
  pack: 100,
  /** GoSweetSpot's costs come without GST; customers always see prices with it */
  gst: 0.15,
  /** what the box and wrap weigh */
  packGrams: 150,
  /** air and padding around what's inside */
  padding: 1.15,
  /** an item with no weight or size on its listing: a guess on the heavy side, and the quote says so */
  guessGrams: 300,
  guessCm: [20, 15, 6],
  /** the flat rates from before, for when there's no live price */
  flat: 1000,
  flatRural: 1500,
  /** how long GoSweetSpot gets to answer */
  timeout: 8000,
  url: 'https://api.gosweetspot.com/api/rates',
});

const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/**
 * One parcel for the whole order. lines: [{ grams, quantity, cm: [l, w, h] | null, ships }]. Returns
 * { kg, length, width, height, estimated }, or null when nothing in it is posted. Weight is rounded up to 100 g. The box
 * is as long and wide as the biggest item and tall enough for everything with padding; estimated is true when any item
 * had no weight or no size.
 */
export function parcelOf(lines, d = DELIVERY) {
  let grams = 0, volume = 0, estimated = false;
  const box = [0, 0, 0];
  for (const line of lines || []) {
    const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
    if (!line?.ships || !quantity) continue;
    const sized = Array.isArray(line.cm) && line.cm.length === 3 && line.cm.every(positive);
    if (!positive(line.grams) || !sized) estimated = true;
    const cm = (sized ? line.cm.map(Number) : [...d.guessCm]).sort((a, b) => b - a);
    grams += (positive(line.grams) ? Number(line.grams) : d.guessGrams) * quantity;
    volume += cm[0] * cm[1] * cm[2] * quantity;
    for (let i = 0; i < 3; i += 1) box[i] = Math.max(box[i], cm[i]);
  }
  if (!volume) return null;
  const length = Math.ceil(box[0]), width = Math.ceil(box[1]);
  const height = Math.max(Math.ceil(box[2]), Math.ceil((volume * d.padding) / (length * width)));
  return { kg: Math.max(1, Math.ceil((grams + d.packGrams) / 100)) / 10, length, width, height, estimated };
}

/** The cheapest Aramex service that isn't a Saturday one, from GoSweetSpot's Available list; null when there's none */
export function pickRate(available, d = DELIVERY) {
  const mine = (Array.isArray(available) ? available : [])
    .filter((r) => String(r?.CarrierName || '').toLowerCase().includes(d.carrier) && !r.IsSaturdayDelivery && positive(r.Cost));
  return mine.sort((a, b) => a.Cost - b.Cost)[0] || null;
}

/** What the customer pays, in cents: the courier's cost with GST, rounded up to a whole cent, plus the packing */
export function deliveryCents(rate, { costHasGst = false, pack = DELIVERY.pack, gst = DELIVERY.gst } = {}) {
  const cost = Math.round(Number(rate.Cost) * 100);
  return Math.ceil(costHasGst ? cost : cost * (1 + gst) - 1e-6) + pack;
}

/** An address with RD in it (RD 2, R.D.1, Rural Delivery): the flat rates' only way of telling */
const looksRural = (address) => /\b(r\.?\s?d\.?\s?\d+|rural delivery)\b/i.test([address?.street, address?.suburb, address?.city].filter(Boolean).join(' '));

/** The flat rate from before, for when there's no live price */
export function fallbackCents(address, d = DELIVERY) {
  return looksRural(address) ? d.flatRural : d.flat;
}

/** GoSweetSpot's rates request for one parcel to a New Zealand address */
export function ratesBody(address, parcel) {
  const text = (v, max) => String(v || '').trim().slice(0, max);
  return {
    Destination: {
      Name: text(address.name, 60) || 'Customer',
      Address: {
        BuildingName: '', StreetAddress: text(address.street, 100), Suburb: text(address.suburb, 60), City: text(address.city, 60),
        PostCode: text(address.postcode, 10), CountryCode: 'NZ',
      },
    },
    IsSaturdayDelivery: false,
    IsSignatureRequired: false,
    Packages: [{ Name: 'Parcel', Kg: parcel.kg, Length: parcel.length, Width: parcel.width, Height: parcel.height, Type: 'Box' }],
  };
}

/**
 * The delivery price for these lines to this address: { cents, rural, source, estimated, service?, costCents? }.
 * source is 'live' (GoSweetSpot's Aramex price), 'fallback' (the flat rates) or 'none' (nothing to post). Never throws.
 */
export async function deliveryQuote(env, { address, lines }, fetcher = fetch, d = DELIVERY) {
  const parcel = parcelOf(lines, d);
  if (!parcel) return { cents: 0, rural: false, source: 'none', estimated: false };
  const fallback = () => ({ cents: fallbackCents(address, d), rural: looksRural(address), source: 'fallback', estimated: parcel.estimated });
  if (!env?.GSS_ACCESS_KEY || !env?.GSS_SITE_ID) return fallback();
  try {
    const response = await fetcher(d.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_key: env.GSS_ACCESS_KEY, site_id: String(env.GSS_SITE_ID) },
      body: JSON.stringify(ratesBody(address || {}, parcel)),
      signal: AbortSignal.timeout(d.timeout),
    });
    if (!response?.ok) return fallback();
    const available = (await response.json())?.Available;
    const rate = pickRate(available, d);
    if (!rate) return fallback();
    return {
      // every service GoSweetSpot offered, for the status note only
      seen: (Array.isArray(available) ? available : []).slice(0, 12).map((r) => ({ carrier: r.CarrierName, type: r.DeliveryType, cost: r.Cost, charge: r.Charge, rural: r.IsRuralDelivery })),
      cents: deliveryCents(rate, { costHasGst: env.GSS_COST_HAS_GST === 'yes', pack: d.pack, gst: d.gst }),
      rural: Boolean(rate.IsRuralDelivery), source: 'live', estimated: parcel.estimated,
      service: String(rate.DeliveryType || '').slice(0, 60), costCents: Math.round(Number(rate.Cost) * 100),
    };
  } catch {
    return fallback();
  }
}

/** Quotes one address may ask for in ten minutes, and how long an answer is kept (the same cart to the same door) */
export const QUOTE_LIMIT = { count: 30, window: 600_000, keep: 600_000, lines: 60 };

const GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };

/** A Shopify variant (with its product's ship_* fields) as a parcel line */
export function lineOf(variant, quantity) {
  const weight = variant?.inventoryItem?.measurement?.weight;
  const cm = ['shipLength', 'shipWidth', 'shipHeight'].map((key) => Number(variant?.product?.[key]?.value));
  return {
    grams: positive(weight?.value) ? Number(weight.value) * (GRAMS[weight.unit] || 1) : 0,
    quantity,
    cm: cm.every(positive) ? cm : null,
    ships: variant?.inventoryItem?.requiresShipping !== false,
  };
}

/** What the website sent, cleaned: { address, lines: [{ id, quantity }] }; throws a RuleError the page can show */
export function quoteInput(body) {
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const address = {
    street: text(body?.address?.street, 100), suburb: text(body?.address?.suburb, 60), city: text(body?.address?.city, 60),
    postcode: text(body?.address?.postcode, 4),
  };
  if (address.street.length < 3 || !address.city) throw new RuleError('Add your street address and town or city.');
  if (!/^\d{4}$/.test(address.postcode)) throw new RuleError('Add your 4-digit postcode.');
  const lines = (Array.isArray(body?.lines) ? body.lines : []).slice(0, QUOTE_LIMIT.lines)
    .map((line) => ({ id: String(line?.variantId ?? '').match(/(\d{5,20})$/)?.[1] || '', quantity: Math.min(99, Math.floor(Number(line?.quantity) || 0)) }))
    .filter((line) => line.id && line.quantity > 0);
  if (!lines.length) throw new RuleError('Your cart is empty.');
  return { address, lines };
}

/** Methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. */
export const deliveryMethods = {
  /**
   * POST /delivery/quote { address: { street, suburb, city, postcode }, lines: [{ variantId, quantity }] }, for anyone
   * with a cart. Answers { cents, rural, source, estimated }: never the courier's own cost.
   */
  async deliveryQuoteFor(body, client = '', now = Date.now()) {
    const { address, lines } = quoteInput(body);
    this.deliveryAsks ||= new Map();
    this.deliveryKept ||= new Map();
    const asks = (this.deliveryAsks.get(client) || []).filter((at) => now - at < QUOTE_LIMIT.window);
    if (asks.length >= QUOTE_LIMIT.count) throw new RuleError('Too many tries just now. Give it a few minutes and try again.', 429);
    this.deliveryAsks.set(client, [...asks, now]);
    const key = JSON.stringify([address, lines]);
    const kept = this.deliveryKept.get(key);
    if (kept && now - kept.at < QUOTE_LIMIT.keep) return kept.answer;
    if (this.deliveryKept.size > 500) this.deliveryKept.clear();
    const data = await this.shopify.graphql(
      `query DeliveryLines($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id
        inventoryItem { requiresShipping measurement { weight { value unit } } }
        product { shipLength: metafield(namespace: "custom", key: "ship_length_cm") { value }
          shipWidth: metafield(namespace: "custom", key: "ship_width_cm") { value }
          shipHeight: metafield(namespace: "custom", key: "ship_height_cm") { value } } } } }`,
      { ids: lines.map((line) => `gid://shopify/ProductVariant/${line.id}`) },
    );
    const found = new Map((data?.nodes || []).filter(Boolean).map((node) => [String(node.id).split('/').pop(), node]));
    const parcelLines = lines.filter((line) => found.has(line.id)).map((line) => lineOf(found.get(line.id), line.quantity));
    if (!parcelLines.length) throw new RuleError("We couldn't find what's in your cart. Refresh the page and try again.");
    const quote = await deliveryQuote(this.env, { address, lines: parcelLines });
    const answer = { cents: quote.cents, rural: quote.rural, source: quote.source, estimated: quote.estimated };
    if (quote.source === 'live') {
      this.deliveryKept.set(key, { at: now, answer });
      this.later?.(recordDelivery(this.env, { at: new Date(now).toISOString(), ...quote, parcel: parcelOf(parcelLines), postcode: address.postcode }));
    }
    return answer;
  },
};

/** The last live quote's workings, for checking against GoSweetSpot's invoices (the config database's status table) */
async function recordDelivery(env, entry) {
  await recordStatus(env, { delivery: entry });
}

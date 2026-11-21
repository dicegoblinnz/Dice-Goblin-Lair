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

/** The tag on a delivery checkout's draft order, and so on its paid order: an online order, though it came from a draft */
export const DELIVERY_TAG = 'lair-delivery';

/** What customers read on the order's delivery line */
export const DELIVERY_WORDS = Object.freeze({
  line: (rural) => (rural ? 'Delivery (Aramex courier, rural)' : 'Delivery (Aramex courier)'),
  sameParcel: (order) => `Same parcel as ${order}`,
  name: 'Add the name the parcel is for.',
});

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
  /** items are weighed 5% on the heavy side, to allow for error (Mo, 21 Nov 2026) */
  heavy: 1.05,
  /** the most one parcel may be before the order is split: a little under Aramex's 25 kg, 1.5 m and 175 litres */
  maxKg: 22,
  maxCm: 140,
  maxLitres: 150,
  /** an item with no weight or size on its listing: a guess on the heavy side, and the quote says so */
  guessGrams: 300,
  guessCm: [20, 15, 6],
  /** the flat rates from before, for when there's no live price */
  flat: 1000,
  flatRural: 1500,
  /** a live courier cost under this (before GST) isn't believed: the flat rates stand */
  floor: 3,
  /** how long GoSweetSpot gets to answer */
  timeout: 8000,
  url: 'https://api.gosweetspot.com/api/rates',
});

const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/** Every posted item on its own: [{ grams, cm (longest side first), estimated }], biggest first */
function unitsOf(lines, d) {
  const units = [];
  for (const line of lines || []) {
    const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
    if (!line?.ships || !quantity) continue;
    const sized = Array.isArray(line.cm) && line.cm.length === 3 && line.cm.every(positive);
    const cm = (sized ? line.cm.map(Number) : [...d.guessCm]).sort((x, y) => y - x);
    const unit = { grams: positive(line.grams) ? Number(line.grams) : d.guessGrams, cm, volume: cm[0] * cm[1] * cm[2], estimated: !positive(line.grams) || !sized };
    for (let i = 0; i < quantity; i += 1) units.push(unit);
  }
  return units.sort((x, y) => y.volume - x.volume || y.grams - x.grams);
}

const emptyBox = () => ({ grams: 0, volume: 0, box: [0, 0, 0], estimated: false, count: 0 });

/** A box with one more item in it */
function withUnit(state, unit) {
  return {
    grams: state.grams + unit.grams, volume: state.volume + unit.volume, box: state.box.map((side, i) => Math.max(side, unit.cm[i])),
    estimated: state.estimated || unit.estimated, count: state.count + 1,
  };
}

/**
 * What a box of items is sent as: { kg, length, width, height, estimated }. The items are weighed on the heavy side,
 * the packing is added and the weight is rounded up to 100 g. The box is as long and wide as the biggest item and tall
 * enough for everything with padding.
 */
function measure(state, d) {
  const length = Math.ceil(state.box[0]), width = Math.ceil(state.box[1]);
  const height = Math.max(Math.ceil(state.box[2]), Math.ceil((state.volume * d.padding) / (length * width) - 1e-6));
  return { kg: Math.max(1, Math.ceil((state.grams * d.heavy + d.packGrams) / 100 - 1e-6)) / 10, length, width, height, estimated: state.estimated };
}

/** Whether Aramex takes a parcel this size, with room to spare */
const fits = (p, d) => p.kg <= d.maxKg && p.length <= d.maxCm && p.length * p.width * p.height <= d.maxLitres * 1000;

/**
 * One parcel for the whole order. lines: [{ grams, quantity, cm: [l, w, h] | null, ships }]. Returns
 * { kg, length, width, height, estimated }, or null when nothing in it is posted; estimated is true when any item had
 * no weight or no size.
 */
export function parcelOf(lines, d = DELIVERY) {
  const units = unitsOf(lines, d);
  return units.length ? measure(units.reduce(withUnit, emptyBox()), d) : null;
}

/**
 * The parcels an order is sent as: one when it fits, two or more when it's too heavy or too bulky for one ([] when
 * nothing is posted). Biggest items first, each into the first parcel with room. An item too big for any parcel gets
 * one of its own: the courier says no to it, not the Lair.
 */
export function parcelsOf(lines, d = DELIVERY) {
  const boxes = [];
  for (const unit of unitsOf(lines, d)) {
    const at = boxes.findIndex((box) => fits(measure(withUnit(box, unit), d), d));
    if (at >= 0) boxes[at] = withUnit(boxes[at], unit);
    else boxes.push(withUnit(emptyBox(), unit));
  }
  return boxes.map((box) => measure(box, d));
}

/** The cheapest Aramex service that isn't a Saturday one, from GoSweetSpot's Available list; null when there's none */
export function pickRate(available, d = DELIVERY) {
  const mine = (Array.isArray(available) ? available : [])
    .filter((r) => String(r?.CarrierName || '').toLowerCase().includes(d.carrier) && !r.IsSaturdayDelivery && Number(r.Cost) >= d.floor);
  return mine.sort((a, b) => a.Cost - b.Cost)[0] || null;
}

/** What the customer pays, in cents: the courier's cost with GST, rounded up to a whole cent, plus the packing */
export function deliveryCents(rate, { costHasGst = false, pack = DELIVERY.pack, gst = DELIVERY.gst } = {}) {
  const cost = Math.round(Number(rate.Cost) * 100);
  return Math.ceil(costHasGst ? cost : cost * (1 + gst) - 1e-6) + pack;
}

/** An address with RD in it (RD 2, R.D.1, Rural Delivery): the flat rates' only way of telling */
function looksRural(address) {
  const text = [address?.street, address?.suburb, address?.city].filter(Boolean).join(' ');
  // RD as an address writes it, never the Rd of a road
  return /\b(RD\s?\d+|R\.\s?D\.\s?\d+)\b/.test(text) || /\brural delivery\b/i.test(text);
}

/** The flat rate from before, for when there's no live price */
export function fallbackCents(address, d = DELIVERY) {
  return looksRural(address) ? d.flatRural : d.flat;
}

/** GoSweetSpot's rates request for one parcel, or several sent together, to a New Zealand address */
export function ratesBody(address, parcel) {
  const parcels = Array.isArray(parcel) ? parcel : [parcel];
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
    Packages: parcels.map((p) => ({ Name: 'Parcel', Kg: p.kg, Length: p.length, Width: p.width, Height: p.height, Type: 'Box' })),
  };
}

/**
 * The delivery price for these lines to this address, one price however many parcels it goes as:
 * { cents, rural, source, estimated, parcels, service?, costCents? }.
 * source is 'live' (GoSweetSpot's Aramex price), 'fallback' (the flat rates) or 'none' (nothing to post). Never throws.
 */
export async function deliveryQuote(env, { address, lines }, fetcher = fetch, d = DELIVERY) {
  const parcels = parcelsOf(lines, d);
  if (!parcels.length) return { cents: 0, rural: false, source: 'none', estimated: false, parcels: 0 };
  const estimated = parcels.some((p) => p.estimated);
  // with no live price every parcel is charged the flat rate, so a big order is never undercharged
  const fallback = () => ({ cents: fallbackCents(address, d) * parcels.length, rural: looksRural(address), source: 'fallback', estimated, parcels: parcels.length });
  if (!env?.GSS_ACCESS_KEY || !env?.GSS_SITE_ID) return fallback();
  try {
    const response = await fetcher(d.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_key: env.GSS_ACCESS_KEY, site_id: String(env.GSS_SITE_ID) },
      body: JSON.stringify(ratesBody(address || {}, parcels)),
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
      rural: Boolean(rate.IsRuralDelivery), source: 'live', estimated, parcels: parcels.length,
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
  const CM = { CENTIMETERS: 1, MILLIMETERS: 0.1, METERS: 100, INCHES: 2.54 };
  const cm = ['shipLength', 'shipWidth', 'shipHeight'].map((key) => {
    const raw = variant?.product?.[key]?.value;
    if (positive(raw)) return Number(raw);
    try {
      const size = JSON.parse(raw);
      return Number(size?.value) * (CM[size?.unit] || 1);
    } catch {
      return NaN;
    }
  });
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

/**
 * What the delivery step sent for checkout, cleaned: quoteInput's address with the name and phone, the lines with their
 * properties, the cart's discount codes (never a same-parcel one: that's the Lair's to honour), email and note.
 */
export function checkoutInput(body) {
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const { address } = quoteInput(body);
  const name = text(body?.address?.name, 60);
  if (name.length < 2) throw new RuleError(DELIVERY_WORDS.name);
  const email = text(body?.email, 120);
  const lines = (Array.isArray(body?.lines) ? body.lines : []).slice(0, QUOTE_LIMIT.lines)
    .map((line) => ({
      variantId: String(line?.variantId ?? '').match(/(\d{5,20})$/)?.[1] || '', quantity: Math.min(99, Math.floor(Number(line?.quantity) || 0)),
      properties: Object.entries(line?.properties && typeof line.properties === 'object' ? line.properties : {}).slice(0, 20)
        .map(([key, value]) => ({ key: text(key, 60), value: text(value, 255) })).filter((p) => p.key && p.value),
    }))
    .filter((line) => line.variantId && line.quantity > 0);
  const codes = [...new Set((Array.isArray(body?.codes) ? body.codes : []).map((code) => text(code, 300)))]
    .filter((code) => code && code.length <= 50 && !code.toUpperCase().startsWith('PARCEL-')).slice(0, 5);
  return {
    address: { ...address, name, phone: text(body?.address?.phone, 20) }, lines, codes,
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '', note: text(body?.note, 500),
  };
}

/** Methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. */
export const deliveryMethods = {
  /**
   * POST /delivery/quote { address: { street, suburb, city, postcode }, lines: [{ variantId, quantity }] }, for anyone
   * with a cart. Answers { cents, rural, source, estimated }: never the courier's own cost.
   */
  async deliveryQuoteFor(body, client = '', now = Date.now(), who = null) {
    const answer = await this.deliveryPriceFor(body, client, now);
    const first = answer.source === 'none' ? null : this.sameParcelFor(who, now);
    return first ? { ...answer, cents: 0, sameParcel: first.order_name || 'your last order' } : answer;
  },

  /**
   * Round 38's same parcel, at the delivery step: the first order this customer may still add to (paid within the
   * hour, posted, nothing added yet), or null. The Lair honours it itself here, since a draft order's delivery line
   * is the Lair's, not one of Shopify's rates for the PARCEL- code to take off.
   */
  sameParcelFor(who, now = Date.now()) {
    if (!who?.customerId || !this.sql) return null;
    return this.sql
      .exec('SELECT order_id, order_name FROM order_rolls WHERE customer_id = ? AND parcel_code IS NOT NULL AND parcel_ends > ? AND parcel_order_id IS NULL ORDER BY paid_at DESC LIMIT 1', String(who.customerId), now)
      .toArray()[0] || null;
  },

  /**
   * POST /delivery/checkout { address: { name, street, suburb, city, postcode, phone }, email, note, codes,
   * lines: [{ variantId, quantity, properties }] }: the cart as a draft order with the delivery on it, priced again
   * here (never by the page), and its checkout link. Answers { checkoutUrl, cents, rural, source, estimated,
   * sameParcel? }; checkoutUrl is null when nothing in the cart is posted, and the page goes to the normal checkout.
   */
  async deliveryCheckoutFor(body, who = null, client = '', now = Date.now()) {
    const input = checkoutInput(body);
    const answer = await this.deliveryQuoteFor(body, client, now, who);
    if (answer.source === 'none') return { checkoutUrl: null, ...answer };
    const first = answer.sameParcel ? this.sameParcelFor(who, now) : null;
    const draft = await this.shopify.createDeliveryCheckout({
      customerId: who?.customerId || null, email: input.email, address: input.address, note: input.note, codes: input.codes, lines: input.lines,
      currency: this.env.CURRENCY || 'NZD',
      delivery: { title: first ? DELIVERY_WORDS.sameParcel(first.order_name || 'your last order') : DELIVERY_WORDS.line(answer.rural), cents: answer.cents },
      attributes: [{ key: '_delivery', value: `${answer.source}${answer.estimated ? ', estimated' : ''}` }, ...(first ? [{ key: '_parcel', value: first.order_id }] : [])],
    });
    return { checkoutUrl: draft.checkoutUrl, ...answer };
  },

  /** The price for this cart to this address, before any same-parcel: { cents, rural, source, estimated } */
  async deliveryPriceFor(body, client = '', now = Date.now()) {
    const { address, lines } = quoteInput(body);
    this.deliveryAsks ||= new Map();
    this.deliveryKept ||= new Map();
    const asks = (this.deliveryAsks.get(client) || []).filter((at) => now - at < QUOTE_LIMIT.window);
    if (asks.length >= QUOTE_LIMIT.count) throw new RuleError('Too many tries just now. Give it a few minutes and try again.', 429);
    if (this.deliveryAsks.size > 2000) this.deliveryAsks.clear();
    this.deliveryAsks.set(client, [...asks, now]);
    const key = JSON.stringify([address, lines]);
    const kept = this.deliveryKept.get(key);
    if (kept && now - kept.at < QUOTE_LIMIT.keep) return kept.answer;
    if (this.deliveryKept.size > 500) this.deliveryKept.clear();
    // Shopify not answering never stops a sale: every line is then a guess, and so is one Shopify doesn't know
    let found = new Map();
    try {
      const data = await this.shopify.graphql(
        `query DeliveryLines($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id
          inventoryItem { requiresShipping measurement { weight { value unit } } }
          product { shipLength: metafield(namespace: "custom", key: "ship_length_cm") { value }
            shipWidth: metafield(namespace: "custom", key: "ship_width_cm") { value }
            shipHeight: metafield(namespace: "custom", key: "ship_height_cm") { value } } } } }`,
        { ids: lines.map((line) => `gid://shopify/ProductVariant/${line.id}`) },
      );
      found = new Map((data?.nodes || []).filter((node) => node?.id).map((node) => [String(node.id).split('/').pop(), node]));
    } catch {
      found = new Map();
    }
    const parcelLines = lines.map((line) => (found.has(line.id) ? lineOf(found.get(line.id), line.quantity) : { grams: 0, quantity: line.quantity, cm: null, ships: true }));
    const quote = await deliveryQuote(this.env, { address, lines: parcelLines });
    const answer = { cents: quote.cents, rural: quote.rural, source: quote.source, estimated: quote.estimated };
    if (quote.source === 'live') {
      this.deliveryKept.set(key, { at: now, answer });
      this.later?.(recordDelivery(this.env, { at: new Date(now).toISOString(), ...quote, parcel: parcelsOf(parcelLines), postcode: address.postcode }));
    }
    return answer;
  },
};

/** The last live quote's workings, for checking against GoSweetSpot's invoices (the config database's status table) */
async function recordDelivery(env, entry) {
  await recordStatus(env, { delivery: entry });
}

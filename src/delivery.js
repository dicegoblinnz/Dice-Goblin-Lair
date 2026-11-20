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
 * This file is the rule and the call to GoSweetSpot. It keeps nothing and changes nothing.
 */

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
    const rate = pickRate((await response.json())?.Available, d);
    if (!rate) return fallback();
    return {
      cents: deliveryCents(rate, { costHasGst: env.GSS_COST_HAS_GST === 'yes', pack: d.pack, gst: d.gst }),
      rural: Boolean(rate.IsRuralDelivery), source: 'live', estimated: parcel.estimated,
      service: String(rate.DeliveryType || '').slice(0, 60), costCents: Math.round(Number(rate.Cost) * 100),
    };
  } catch {
    return fallback();
  }
}

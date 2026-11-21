// Round 48: delivery priced from the parcel and the address (contract v48-delivery). Mo, 21 Nov 2026: "calculates the
// delivery fee and give them the real number but use only aramex ... maybe add $1 extra on every order for the package
// and wrap cost", after a rural parcel cost him $16 on a $10 delivery.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY, deliveryCents, deliveryQuote, fallbackCents, parcelOf, parcelsOf, pickRate, ratesBody } from '../src/delivery.js';

const dice = { grams: 120, quantity: 1, cm: [12, 8, 3], ships: true };
const game = { grams: 1800, quantity: 1, cm: [30, 30, 8], ships: true };
const rate = (o = {}) => ({ CarrierName: 'Aramex', DeliveryType: 'Standard', Cost: 5, IsRuralDelivery: false, IsSaturdayDelivery: false, ...o });
const ADDRESS = { street: '12 Example Street', suburb: 'Royal Oak', city: 'Auckland', postcode: '1023' };
const ENV = { GSS_ACCESS_KEY: 'key', GSS_SITE_ID: '1' };

test('a parcel weighs its items and its packing, rounded up to 100 g', () => {
  const p = parcelOf([dice, { ...dice, quantity: 2 }]);
  assert.equal(p.kg, 0.6); // 360 g + 150 g packing = 510 g
  assert.equal(p.estimated, false);
});

test('a parcel is at least as big as its biggest item, and grows with what is in it', () => {
  const one = parcelOf([game]);
  assert.deepEqual([one.length, one.width], [30, 30]);
  assert.ok(one.height >= 8);
  const three = parcelOf([{ ...game, quantity: 3 }]);
  assert.ok(three.height >= 24, 'three boxes stack');
});

test('an item with no weight or size gets the default, and the parcel says it is a guess', () => {
  const p = parcelOf([{ grams: 0, quantity: 1, cm: null, ships: true }]);
  assert.equal(p.estimated, true);
  assert.equal(p.kg, Math.ceil((DELIVERY.guessGrams + DELIVERY.packGrams) / 100) / 10);
});

test('things that are never posted are left out, and a cart of only those has no parcel', () => {
  assert.equal(parcelOf([{ ...dice, ships: false }]), null);
  assert.equal(parcelOf([dice, { ...game, ships: false }]).kg, 0.3);
});

test('only Aramex, never a Saturday service, and the cheapest of what is left', () => {
  const picked = pickRate([rate({ CarrierName: 'Post Haste', Cost: 3 }), rate({ Cost: 7 }), rate({ Cost: 6, DeliveryType: 'Parcel' }), rate({ Cost: 2, IsSaturdayDelivery: true })]);
  assert.equal(picked.Cost, 6);
  assert.equal(pickRate([rate({ CarrierName: 'NZ Post' })]), null);
  assert.equal(pickRate(undefined), null);
});

test('the customer pays the courier cost with GST, plus $1 for packing', () => {
  assert.equal(deliveryCents(rate({ Cost: 5 })), 675); // $5.00 + 15% = $5.75, + $1
  assert.equal(deliveryCents(rate({ Cost: 8.6 })), 1089);
  assert.equal(deliveryCents(rate({ Cost: 13.91 })), 1700, 'never a part cent, rounded up');
  assert.equal(deliveryCents(rate({ Cost: 5 }), { costHasGst: true }), 600);
});

test('the request to GoSweetSpot carries the address and the one parcel', () => {
  const body = ratesBody(ADDRESS, parcelOf([dice]));
  assert.equal(body.Destination.Address.PostCode, '1023');
  assert.equal(body.Destination.Address.CountryCode, 'NZ');
  assert.equal(body.Packages.length, 1);
  assert.equal(body.Packages[0].Kg, 0.3);
});

test('a live quote: Aramex to the door, rural told by the courier, not by the customer', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ Available: [rate({ Cost: 13.91, IsRuralDelivery: true })], Rejected: [] }), { status: 200 });
  };
  const q = await deliveryQuote(ENV, { address: ADDRESS, lines: [dice] }, fetch);
  assert.deepEqual({ cents: q.cents, rural: q.rural, source: q.source, costCents: q.costCents }, { cents: 1700, rural: true, source: 'live', costCents: 1391 });
  assert.equal(calls[0].url, 'https://api.gosweetspot.com/api/rates');
  assert.equal(calls[0].init.headers.access_key, 'key');
  assert.equal(calls[0].init.headers.site_id, '1');
});

test('when GoSweetSpot is down, has no Aramex price, or no key is set, the old flat rates stand', async () => {
  const down = async () => { throw new Error('down'); };
  const q = await deliveryQuote(ENV, { address: ADDRESS, lines: [dice] }, down);
  assert.deepEqual({ cents: q.cents, source: q.source }, { cents: 1000, source: 'fallback' });
  const rd = await deliveryQuote(ENV, { address: { ...ADDRESS, street: '45 Farm Road RD 2' }, lines: [dice] }, down);
  assert.equal(rd.cents, 1500);
  const none = await deliveryQuote(ENV, { address: ADDRESS, lines: [dice] }, async () => new Response(JSON.stringify({ Available: [rate({ CarrierName: 'NZ Post' })] })));
  assert.equal(none.source, 'fallback');
  let asked = 0;
  const noKey = await deliveryQuote({}, { address: ADDRESS, lines: [dice] }, async () => { asked += 1; });
  assert.equal(noKey.source, 'fallback');
  assert.equal(asked, 0);
  assert.equal(fallbackCents({ street: 'R.D.1', city: 'Pukekohe' }), 1500);
  assert.equal(fallbackCents({ street: '12 Mt Eden Rd 3', city: 'Auckland' }), 1000, 'Rd is a road');
  assert.equal(fallbackCents({ street: '3 Garden Road', city: 'Auckland' }), 1000);
});

test('nothing to post costs nothing', async () => {
  const q = await deliveryQuote(ENV, { address: ADDRESS, lines: [{ ...dice, ships: false }] }, async () => { throw new Error('not asked'); });
  assert.deepEqual({ cents: q.cents, source: q.source }, { cents: 0, source: 'none' });
});

// POST /delivery/quote
const { QUOTE_LIMIT, deliveryMethods, lineOf, quoteInput } = await import('../src/delivery.js');
const variant = (id, o = {}) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  inventoryItem: { requiresShipping: o.ships ?? true, measurement: { weight: { value: o.value ?? 0.4, unit: o.unit || 'KILOGRAMS' } } },
  product: { shipLength: { value: '20' }, shipWidth: { value: '10' }, shipHeight: { value: '5' } },
});
const BODY = { address: ADDRESS, lines: [{ variantId: 'gid://shopify/ProductVariant/4000000001', quantity: 2 }] };

test('a variant becomes a parcel line: grams whatever its unit, its product\'s size, and whether it is posted', () => {
  assert.deepEqual(lineOf(variant(1), 2), { grams: 400, quantity: 2, cm: [20, 10, 5], ships: true });
  assert.equal(lineOf(variant(1, { value: 250, unit: 'GRAMS' }), 1).grams, 250);
  assert.equal(lineOf({ inventoryItem: { requiresShipping: false }, product: {} }, 1).ships, false);
  assert.equal(lineOf({ inventoryItem: {}, product: {} }, 1).cm, null);
});

test('a quote needs a street, a town and a 4-digit postcode, and something in the cart', () => {
  assert.throws(() => quoteInput({ ...BODY, address: { ...ADDRESS, postcode: '10' } }), /postcode/);
  assert.throws(() => quoteInput({ ...BODY, address: { ...ADDRESS, street: '' } }), /street/);
  assert.throws(() => quoteInput({ address: ADDRESS, lines: [{ variantId: 'x', quantity: 1 }] }), /empty/);
  assert.equal(quoteInput(BODY).lines[0].id, '4000000001');
});

test('the route answers the price without the courier\'s cost, keeps it for the same cart, and caps the asking', async () => {
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked += 1; return new Response(JSON.stringify({ Available: [rate({ Cost: 5 })] })); };
  try {
    const lair = { env: ENV, shopify: { graphql: async () => ({ nodes: [variant(4000000001)] }) }, ...deliveryMethods };
    const first = await lair.deliveryQuoteFor(BODY, 'a', 1000);
    assert.deepEqual(first, { cents: 675, rural: false, source: 'live', estimated: false });
    await lair.deliveryQuoteFor(BODY, 'a', 2000);
    assert.equal(asked, 1, 'the same cart to the same door is not asked twice');
    for (let i = 0; i < QUOTE_LIMIT.count - 2; i += 1) await lair.deliveryQuoteFor(BODY, 'a', 3000);
    await assert.rejects(lair.deliveryQuoteFor(BODY, 'a', 4000), /Too many/);
    assert.equal((await lair.deliveryQuoteFor(BODY, 'b', 4000)).cents, 675, 'someone else is not held up');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a courier cost too small to be true is not believed', () => {
  assert.equal(pickRate([rate({ Cost: 0.01 }), rate({ Cost: 9.5 })]).Cost, 9.5);
  assert.equal(pickRate([rate({ Cost: 0.01 })]), null);
});

test('a size kept as Shopify\'s dimension type is read too', () => {
  const v = variant(1);
  v.product.shipLength = { value: '{"value":300,"unit":"MILLIMETERS"}' };
  assert.deepEqual(lineOf(v, 1).cm, [30, 10, 5]);
});

test('Shopify not answering, or not knowing an item, never stops the quote: that line is a guess', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Available: [rate({ Cost: 5 })] }));
  try {
    const down = { env: ENV, shopify: { graphql: async () => { throw new Error('502'); } }, ...deliveryMethods };
    assert.deepEqual(await down.deliveryQuoteFor(BODY, 'a', 1), { cents: 675, rural: false, source: 'live', estimated: true });
    const part = { env: ENV, shopify: { graphql: async () => ({ nodes: [variant(4000000001), null] }) }, ...deliveryMethods };
    const two = { address: ADDRESS, lines: [...BODY.lines, { variantId: '4000000002', quantity: 1 }] };
    assert.equal((await part.deliveryQuoteFor(two, 'a', 1)).estimated, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Packing (contract v48, section 4). Mo, 21 Nov 2026: the Lair chooses the box sizes itself, "on the slightly higher
// side" to allow for error, as one parcel or as two or more when the order needs it. The customer sees one price.
test('an ordinary order is one parcel', () => {
  const parcels = parcelsOf([dice, game]);
  assert.equal(parcels.length, 1);
  assert.deepEqual(parcels[0], parcelOf([dice, game]));
  assert.deepEqual(parcelsOf([{ ...dice, ships: false }]), []);
});

test('an order too heavy for one parcel is split, and every item is in a parcel', () => {
  const heavy = { grams: 9000, quantity: 5, cm: [30, 30, 10], ships: true }; // 45 kg of rulebooks
  const parcels = parcelsOf([heavy, dice]);
  assert.ok(parcels.length >= 3, 'two of these to a parcel at most');
  for (const p of parcels) assert.ok(p.kg <= DELIVERY.maxKg, `${p.kg} kg is under the most one parcel may weigh`);
  const packing = (parcels.length * DELIVERY.packGrams) / 1000;
  assert.ok(parcels.reduce((sum, p) => sum + p.kg, 0) >= 45.12 + packing, 'nothing left behind');
});

test('an order too bulky for one parcel is split by size too', () => {
  const big = { grams: 2000, quantity: 4, cm: [60, 40, 30], ships: true }; // 72 litres each
  const parcels = parcelsOf([big]);
  assert.equal(parcels.length, 4);
  for (const p of parcels) assert.ok(p.length * p.width * p.height <= DELIVERY.maxLitres * 1000);
});

test('one item too big for any parcel still gets a parcel of its own: the courier says no, not the Lair', () => {
  const parcels = parcelsOf([{ grams: 30000, quantity: 1, cm: [160, 40, 40], ships: true }, dice]);
  assert.equal(parcels.length, 2);
});

test('parcels are sized on the heavy side', () => {
  // 1,000 g of items is weighed as 1,050 g, plus 150 g of packing, rounded up to 100 g
  assert.equal(parcelOf([{ grams: 1000, quantity: 1, cm: [20, 15, 6], ships: true }]).kg, 1.2);
});

test('several parcels go to GoSweetSpot as one request, and the customer gets one price', async () => {
  const heavy = { grams: 9000, quantity: 4, cm: [30, 30, 10], ships: true };
  let sent;
  const quote = await deliveryQuote(ENV, { address: ADDRESS, lines: [heavy] }, async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ Available: [rate({ Cost: 20 })] }) };
  });
  assert.equal(sent.Packages.length, 2);
  assert.equal(quote.cents, 2400, '$20 + GST, and one $1 for packing');
  assert.equal(quote.parcels, 2);
});

test('with no live price, each parcel is charged the flat rate', async () => {
  const heavy = { grams: 9000, quantity: 4, cm: [30, 30, 10], ships: true };
  const quote = await deliveryQuote({}, { address: ADDRESS, lines: [heavy] });
  assert.equal(quote.source, 'fallback');
  assert.equal(quote.cents, 2 * DELIVERY.flat);
});

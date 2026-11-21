// Round 48, POST /delivery/checkout (contract v48-delivery, section 5). Mo, 21 Nov 2026: "a draft order with the delivery
// fee on it, then prove the dice deal, free sleeves, discount codes, store credit, gift cards, d20 rolls and Same parcel
// all still work". The Lair's part of each is checked here; Shopify's part (its own discounts and payment page) is
// checked against the store with draftOrderCalculate and a real checkout, noted in the contract.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { DELIVERY_TAG, deliveryMethods } from '../src/delivery.js';
import { ORDER_ROLL_TABLES, orderRollMethods } from '../src/order-rolls.js';
import { ShopifyAdmin } from '../src/shopify.js';

const ADDRESS = { name: 'Mia Chen', street: '12 Example Street', suburb: 'Royal Oak', city: 'Auckland', postcode: '1023', phone: '021 555 0100' };
const ENV = { GSS_ACCESS_KEY: 'key', GSS_SITE_ID: '1', CURRENCY: 'NZD' };
const MIA = '6001';
const NOW = Date.UTC(2026, 10, 21, 2);
const variant = (id) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  inventoryItem: { requiresShipping: true, measurement: { weight: { value: 0.4, unit: 'KILOGRAMS' } } },
  product: { shipLength: { value: '20' }, shipWidth: { value: '10' }, shipHeight: { value: '5' } },
});
const BODY = {
  address: ADDRESS, email: 'mia@example.com', note: 'Leave it by the gnome',
  lines: [{ variantId: 4000000001, quantity: 3, properties: { _deck: 'yes' } }], codes: ['WELCOME10'],
  // a page can't name its own price
  cents: 1,
};

function sqlOf() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      cloudflareSql(query, bindings);
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  for (const ddl of ORDER_ROLL_TABLES) sql.exec(ddl);
  return sql;
}

/** A Lair with the delivery and order-roll methods, a Shopify that knows the cart and keeps the drafts it's asked for */
function lairOf() {
  const drafts = [];
  const lair = {
    env: ENV, sql: sqlOf(), drafts,
    shopify: {
      configured: true,
      graphql: async () => ({ nodes: [variant(4000000001)] }),
      createDeliveryCheckout: async (input) => { drafts.push(input); return { draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://shop.test/invoice/1' }; },
    },
    ...orderRollMethods, ...deliveryMethods,
    // nothing in the background here: no emails, codes or tags
    later() {}, orderRollsFollowUp() {}, parcelTags() {},
  };
  return lair;
}
const withRate = async (cost, run) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Available: [{ CarrierName: 'Aramex', DeliveryType: 'Standard', Cost: cost, IsRuralDelivery: false, IsSaturdayDelivery: false }] }));
  try { return await run(); } finally { globalThis.fetch = realFetch; }
};
const firstOrder = (lair, { ends = NOW + 30 * 60_000, used = null } = {}) => lair.sql.exec(
  `INSERT INTO order_rolls (order_id, customer_id, order_name, counted, boxes, doubled, rolls, paid_at, created_at, parcel_ok, parcel_code, parcel_ends, parcel_order_id)
   VALUES ('gid://shopify/Order/1550', ?, '#1550', 20000, 0, 0, 1, ?, ?, 1, 'PARCEL-7KQ2XM', ?, ?)`, MIA, NOW, NOW, ends, used,
);

test('checkout: a draft order for the cart with the delivery the Lair quoted on it, and its checkout link', async () => {
  const lair = lairOf();
  const answer = await withRate(5, () => lair.deliveryCheckoutFor(BODY, { customerId: MIA }, 'a', NOW));
  assert.deepEqual(answer, { checkoutUrl: 'https://shop.test/invoice/1', cents: 675, rural: false, source: 'live', estimated: false });
  const [draft] = lair.drafts;
  assert.equal(draft.delivery.cents, 675, 'the price is the Lair\'s own quote, never the page\'s');
  assert.equal(draft.delivery.title, 'Delivery (Aramex courier)');
  assert.equal(draft.customerId, MIA);
  assert.deepEqual(draft.lines, [{ variantId: '4000000001', quantity: 3, properties: [{ key: '_deck', value: 'yes' }] }]);
  assert.equal(draft.address.name, 'Mia Chen');
  assert.equal(draft.note, 'Leave it by the gnome');
});

test('checkout: the name the parcel is for is asked for, and a cart with nothing to post is sent to the normal checkout', async () => {
  const lair = lairOf();
  await assert.rejects(lair.deliveryCheckoutFor({ ...BODY, address: { ...ADDRESS, name: '' } }, { customerId: null }, 'a', NOW), /name/);
  lair.shopify.graphql = async () => ({ nodes: [{ ...variant(4000000001), inventoryItem: { requiresShipping: false } }] });
  const answer = await lair.deliveryCheckoutFor(BODY, { customerId: null }, 'a', NOW);
  assert.deepEqual(answer, { checkoutUrl: null, cents: 0, rural: false, source: 'none', estimated: false });
  assert.equal(lair.drafts.length, 0);
});

test('discount codes: the cart\'s codes go on the draft, and the same-parcel code is the Lair\'s to honour, not Shopify\'s', async () => {
  const lair = lairOf();
  await withRate(5, () => lair.deliveryCheckoutFor({ ...BODY, codes: ['welcome10', 'PARCEL-AAAAAA', 'x'.repeat(300)] }, { customerId: MIA }, 'a', NOW));
  assert.deepEqual(lair.drafts[0].codes, ['welcome10']);
});

test('the draft Shopify is asked for: automatic discounts on (the dice deal, free sleeves), codes on it and allowed at checkout, the customer attached (store credit), tagged', async () => {
  let sent;
  const shopify = Object.create(ShopifyAdmin.prototype);
  shopify.graphql = async (query, variables) => { sent = { query, input: variables.input }; return { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', invoiceUrl: 'https://shop.test/invoice/9' }, userErrors: [] } }; };
  const made = await shopify.createDeliveryCheckout({
    customerId: MIA, email: 'mia@example.com', address: ADDRESS, note: 'By the gnome', codes: ['WELCOME10'], currency: 'NZD',
    lines: [{ variantId: '4000000001', quantity: 3, properties: [{ key: '_deck', value: 'yes' }] }],
    delivery: { title: 'Delivery (Aramex courier)', cents: 675 }, attributes: [{ key: '_delivery', value: 'live' }],
  });
  assert.deepEqual(made, { draftOrderId: 'gid://shopify/DraftOrder/9', checkoutUrl: 'https://shop.test/invoice/9' });
  const { input } = sent;
  assert.equal(input.acceptAutomaticDiscounts, true);
  assert.equal(input.allowDiscountCodesInCheckout, true);
  assert.deepEqual(input.discountCodes, ['WELCOME10']);
  assert.deepEqual(input.purchasingEntity, { customerId: `gid://shopify/Customer/${MIA}` });
  assert.deepEqual(input.tags, [DELIVERY_TAG]);
  assert.deepEqual(input.shippingLine, { title: 'Delivery (Aramex courier)', priceWithCurrency: { amount: '6.75', currencyCode: 'NZD' } });
  assert.deepEqual(input.lineItems, [{ variantId: 'gid://shopify/ProductVariant/4000000001', quantity: 3, customAttributes: [{ key: '_deck', value: 'yes' }] }]);
  assert.equal(input.shippingAddress.zip, '1023');
  assert.equal(input.shippingAddress.countryCode, 'NZ');
  assert.equal(input.shippingAddress.firstName, 'Mia');
  assert.equal(input.shippingAddress.lastName, 'Chen');
  // a guest's draft has no customer on it
  await shopify.createDeliveryCheckout({ customerId: null, address: ADDRESS, lines: [], delivery: { title: 'Delivery', cents: 0 }, currency: 'NZD' });
  assert.equal(sent.input.purchasingEntity, undefined);
});

test('Same parcel: within the hour, the customer\'s second order goes for no extra delivery, and the quote says so first', async () => {
  const lair = lairOf();
  firstOrder(lair);
  const quote = await withRate(5, () => lair.deliveryQuoteFor(BODY, 'a', NOW, { customerId: MIA }));
  assert.deepEqual(quote, { cents: 0, rural: false, source: 'live', estimated: false, sameParcel: '#1550' });
  const answer = await withRate(5, () => lair.deliveryCheckoutFor(BODY, { customerId: MIA }, 'a', NOW));
  assert.equal(answer.cents, 0);
  assert.equal(lair.drafts[0].delivery.cents, 0);
  assert.equal(lair.drafts[0].delivery.title, 'Same parcel as #1550');
  assert.deepEqual(lair.drafts[0].attributes.find((a) => a.key === '_parcel'), { key: '_parcel', value: 'gid://shopify/Order/1550' });
});

test('Same parcel: not for someone else, not after the hour, not twice', async () => {
  for (const [who, row] of [['6002', {}], [MIA, { ends: NOW - 1 }], [MIA, { used: 'gid://shopify/Order/1551' }], [null, {}]]) {
    const lair = lairOf();
    firstOrder(lair, row);
    const answer = await withRate(5, () => lair.deliveryCheckoutFor(BODY, { customerId: who }, 'a', NOW));
    assert.equal(answer.cents, 675);
  }
});

// The paid order: a delivery checkout's order comes from a draft, and must still count as the online order it is
const paidOrder = (n, extra = {}) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: 'shopify_draft_order',
  line_items: [{ id: n * 10, title: 'Galaxy Dice Set', vendor: 'Dice Goblin NZ', price: '400.00', quantity: 1, discount_allocations: [] }], ...extra,
});
const RULES = { tz: 'Pacific/Auckland', rolls: { on: true, every: 200, doubleDays: [] } };
const spendOf = (n, codes = []) => ({ customerId: MIA, name: `#${n}`, discountCodes: codes, processedAt: NOW });

test('d20 rolls: an order paid through the delivery step earns its rolls as any online order does; other draft orders still don\'t', () => {
  const lair = lairOf();
  const viaDelivery = lair.orderRollsPaid(paidOrder(1601, { tags: `${DELIVERY_TAG}, something` }), 'gid://shopify/Order/1601', { spend: spendOf(1601), rules: RULES, now: NOW });
  assert.deepEqual(viaDelivery, { rolls: 2 });
  assert.equal(lair.orderRollsPaid(paidOrder(1602), 'gid://shopify/Order/1602', { spend: spendOf(1602), rules: RULES, now: NOW }), null);
  assert.equal(lair.orderRollsPaid(paidOrder(1603, { tags: 'lair-till' }), 'gid://shopify/Order/1603', { spend: spendOf(1603), rules: RULES, now: NOW }), null);
});

test('Same parcel: the paid second order is linked to its first by the delivery step\'s own mark, once, and only for its own customer', () => {
  const lair = lairOf();
  firstOrder(lair);
  const mark = { tags: DELIVERY_TAG, note_attributes: [{ name: '_parcel', value: 'gid://shopify/Order/1550' }] };
  assert.equal(lair.orderRollsPaid(paidOrder(1552, mark), 'gid://shopify/Order/1552', { spend: { ...spendOf(1552), customerId: '6002' }, rules: RULES, now: NOW }).parcel, undefined);
  const second = lair.orderRollsPaid(paidOrder(1551, mark), 'gid://shopify/Order/1551', { spend: spendOf(1551), rules: RULES, now: NOW });
  assert.equal(second.parcel, '#1550');
  const row = lair.sql.exec("SELECT * FROM order_rolls WHERE order_id = 'gid://shopify/Order/1550'").one();
  assert.equal(row.parcel_order_id, 'gid://shopify/Order/1551');
  // the second order of a parcel doesn't start a parcel of its own
  assert.equal(lair.sql.exec("SELECT parcel_ok FROM order_rolls WHERE order_id = 'gid://shopify/Order/1551'").one().parcel_ok, 0);
});

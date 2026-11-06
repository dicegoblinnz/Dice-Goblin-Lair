// Round 32, the till, part 3: the till's own Shopify operations ask Admin API 2026-10 (TILL_API_VERSION), whatever
// version the rest of the Lair is on. Mo at the counter (6 Nov 2026): "it keeps not working with the bar code of the
// items when I scan them it doest go through says no". The till's product lookup asks for a variant's barcodes
// (ProductVariant.barcodes), which only came in 2026-10, and the Lair is on 2026-07: Shopify answered with an error,
// so every product scan failed. Here a Shopify that answers each version as the real one does. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyAdmin, TILL_API_VERSION } from '../src/shopify.js';

const realFetch = globalThis.fetch;
let asked;

/** A variant as Shopify 2026-10 sends it */
const VARIANT = {
  id: 'gid://shopify/ProductVariant/5021', title: 'Default Title', sku: 'RB-RAD-BOOSTER', price: '11.00', inventoryQuantity: 24, inventoryPolicy: 'DENY',
  inventoryItem: { tracked: true }, barcodes: { nodes: [{ value: '810155276195' }] },
  product: { id: 'gid://shopify/Product/9021', title: 'Riftbound Radiance', productType: 'Trading Card Games', vendor: 'Riot Games', status: 'ACTIVE', isGiftCard: false },
};

/** Shopify's Admin API, each version as it is: a variant's barcodes don't exist before 2026-10 */
function fakeShopifyApi() {
  asked = [];
  globalThis.fetch = async (url, init) => {
    const version = String(url).match(/\/admin\/api\/([^/]+)\/graphql\.json$/)?.[1];
    const { query } = JSON.parse(init.body);
    const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] || '';
    asked.push({ version, name });
    const answer = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (version < '2026-10' && /\bbarcodes\s*\(/.test(query)) {
      return new Response(JSON.stringify({ errors: [{ message: "Field 'barcodes' doesn't exist on type 'ProductVariant'", extensions: { code: 'undefinedField' } }] }), { status: 200 });
    }
    if (name === 'LairTillVariants') return answer({ productVariants: { nodes: [VARIANT] } });
    if (name === 'LairTillSearch') return answer({ products: { nodes: [{ ...VARIANT.product, variants: { nodes: [VARIANT] } }] } });
    const figures = { taxesIncluded: true, subtotalPriceSet: { shopMoney: { amount: '11.00', currencyCode: 'NZD' } }, totalPriceSet: { shopMoney: { amount: '11.00', currencyCode: 'NZD' } }, totalTaxSet: { shopMoney: { amount: '1.43', currencyCode: 'NZD' } }, platformDiscounts: [] };
    if (name === 'LairTillCalculate') return answer({ draftOrderCalculate: { calculatedDraftOrder: { ...figures, lineItems: [] }, userErrors: [] } });
    if (name === 'LairTillDraft') return answer({ draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', ready: true, status: 'OPEN', ...figures, lineItems: { nodes: [] } }, userErrors: [] } });
    if (name === 'LairTillDraftNow') return answer({ draftOrder: { id: 'gid://shopify/DraftOrder/1', status: 'OPEN', ready: true, order: null, ...figures, lineItems: { nodes: [] } } });
    if (name === 'LairTillFulfilment') return answer({ order: { id: 'gid://shopify/Order/1', fulfillmentOrders: { nodes: [] } } });
    return answer({});
  };
}

const admin = (version) => {
  const a = new ShopifyAdmin({ SHOP: 'dice-goblin.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', ...(version ? { API_VERSION: version } : {}) }, null);
  a.accessToken = async () => 'token';
  return a;
};

beforeEach(fakeShopifyApi);
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('round 32 part 3 (Mo, 6 Nov 2026): a product\'s barcode is found with the Lair on 2026-07, asked of Shopify 2026-10', async () => {
  assert.equal(TILL_API_VERSION, '2026-10');
  const shop = admin('2026-07');
  const found = await shop.tillVariants('810155276195', null);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].variant.barcodes, ['810155276195']);
  assert.equal(found[0].product.title, 'Riftbound Radiance');
  assert.equal(found[0].variant.price, 1100);
  assert.deepEqual(asked, [{ version: '2026-10', name: 'LairTillVariants' }]);
});

test('round 32 part 3: every one of the till\'s own operations asks 2026-10; the rest of the Lair stays on its version', async () => {
  const shop = admin('2026-07');
  await shop.tillSearch(['riftbound'], null);
  await shop.tillCalculate({ lines: [{ uuid: 'u1', variantId: '5021', qty: 1 }], currency: 'NZD' });
  await shop.createTillDraft({ customerId: null, lines: [{ uuid: 'u1', variantId: '5021', qty: 1 }], currency: 'NZD', tags: ['lair-till'], note: 'Till', marker: { _lair_till: 'x' } });
  await shop.tillDraft('gid://shopify/DraftOrder/1');
  await shop.fulfilTillOrder('gid://shopify/Order/1', 'gid://shopify/Location/1');
  assert.deepEqual(asked.map((a) => a.name), ['LairTillSearch', 'LairTillCalculate', 'LairTillDraft', 'LairTillDraftNow', 'LairTillFulfilment']);
  assert.ok(asked.every((a) => a.version === '2026-10'), JSON.stringify(asked));
  // anything else the Lair asks stays on the Lair's own version
  asked = [];
  await shop.graphql('query LairShopName { shop { name } }');
  assert.deepEqual(asked, [{ version: '2026-07', name: 'LairShopName' }]);
});

test('round 32 part 3: a Lair already on a newer version asks that one for the till too', async () => {
  const shop = admin('2027-01');
  await shop.tillVariants('810155276195', null);
  assert.deepEqual(asked, [{ version: '2027-01', name: 'LairTillVariants' }]);
  // and with no version set, the Lair's own 2026-07 and the till's 2026-10
  asked = [];
  const plain = admin(null);
  await plain.tillVariants('810155276195', null);
  await plain.graphql('query LairShopName { shop { name } }');
  assert.deepEqual(asked, [{ version: '2026-10', name: 'LairTillVariants' }, { version: '2026-07', name: 'LairShopName' }]);
});

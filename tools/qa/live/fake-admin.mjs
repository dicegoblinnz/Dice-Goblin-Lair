// A stand-in for Shopify's Admin API (OAuth token + GraphQL), for the Lair app under `wrangler dev`.
// The dev entry (dev/worker-entry.mjs) sends every https://ep0qiq-rp.myshopify.com/... request here instead.
//
// It answers the app's GraphQL operations by name with the same data the theme preview renders:
//   rooms   = the theme's default rooms (T1-T21, P1-P4, G1-G4, F1 at $15)
//   events  = the mock renderer's lair_event metaobjects (events-mock.mjs: round 4 payment / lock_tables included)
//   theme   = dg-theme-t5's config/settings_data.json (hours, shop tables, prices)
// and keeps draft orders, orders (for orders/paid spend and session pass buyers), store credit and discount codes in
// memory. Round 6 adds library copies (VariantCopies), a customer's orders (CustomerOrders: the last 60 days unless
// the scopes include read_all_orders, like Shopify), when accounts were made (CustomersSince), account emails
// (CustomerEmail) and session gift buyers (OrderGiftBuyer).
//
// Control routes for the test scripts (never part of Shopify):
//   GET  /__fake/state                       everything it holds
//   POST /__fake/set { failCheckout, failCredit, failDiscount, failBuyer, failVariant, failOrders, scopes }
//                                            failDiscount: discountCodeBasicCreate answers with a userError;
//                                            failBuyer: OrderBuyer and OrderGiftBuyer fail like a store without protected
//                                            data approval; failVariant: VariantCopies is refused like a store that
//                                            hasn't approved read_products and read_inventory yet; failOrders:
//                                            CustomerOrders fails (Shopify down); scopes: the scopes the app has (null:
//                                            the usual ones, read_products and read_inventory included)
//   POST /__fake/customer { id, tags, name, email, createdAt (ISO), verified (false: the account email isn't verified) }
//   POST /__fake/order { id, customerId, subtotal (cents), source, name ("#1550"), billingName, shippingName, email,
//                        createdAt (ISO, default now), status ('PAID' default), cancelled }
//   POST /__fake/variant { id, quantity, tracked }   a library copy's inventory (round 6)
//   POST /__fake/variant-code { id, productId, handle, productTitle, title, sku, barcode, price ('4.50'), available, image,
//        productImage, status ('ACTIVE'), giftCard, sellingPlan, libraryCode }   round 7: a variant LairVariantByCode finds
//        by its barcode or SKU (library copies have a libraryCode); POST /__fake/set { failVariantCode } refuses that lookup
//        like a store without read_products. POST /__fake/discount-use { code, count }: how often a code was used
//        (LairGiftCodeUse); orders take discountCodes (OrderSpend answers them, with processedAt)
//   POST /__fake/draft-paid { draftId, orderId }  the checkout was paid: the draft order turned into orderId
//   GET  /__fake/calls                       every GraphQL call so far (operation, variables)
//   GET  /__fake/emails                      every email the app sent (Resend stand-in at /resend/emails[/batch])
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lairEvents } from '../theme-mock/events-mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = process.env.DG_THEME || '/home/claude/dg-theme-t5';
const PORT = Number(process.env.FAKE_PORT || 8799);
const LOG = path.join(HERE, 'fake-admin.calls.jsonl');

const state = {
  failCheckout: false,
  failCredit: false,
  failDiscount: false,
  failBuyer: false,
  failVariant: false,
  failOrders: false,
  scopes: null,
  variants: {}, // round 6: variant id -> { quantity, tracked }
  variantCodes: [], // round 7: variants found by barcode or SKU (LairVariantByCode)
  failVariantCode: false, // round 7: LairVariantByCode refused (read_products not approved)
  discountUses: {}, // round 7: discount code (upper case) -> times used (LairGiftCodeUse)
  customers: {
    7001: ['staff'], // Mo, staff
    7101: [], // Sam Jones, member
    7102: [], // Kiri Smith, a friend who pays a share
    7103: ['gm'], // Ana Rangi, trusted GM
    7104: [], // Leo Tane, player
    7105: [], // Zoë van der Berg, brand new
    7106: [], // Tui Harper, a weekly regular (round 5 flows)
    7107: [], // Ari Moana, buys a pass before ever opening My Lair
  },
  // names and emails for OrderBuyer (protected customer data), the same made-up people as harness.mjs
  people: {
    7001: { name: 'Mo Ashgrove', email: 'mo@dicegoblin.test' },
    7101: { name: 'Sam Jones', email: 'sam@example.com' },
    7102: { name: 'Kiri Smith', email: 'kiri@example.com' },
    7103: { name: 'Ana Rangi', email: 'ana@example.com' },
    7104: { name: 'Leo Tane', email: 'leo@example.com' },
    7105: { name: 'Zoë van der Berg', email: 'zoe@example.com' },
    7106: { name: 'Tui Harper', email: 'tui@example.com' },
    7107: { name: 'Ari Moana', email: 'ari@example.com' },
  },
  drafts: {}, // id -> { id, status, orderId, input }
  orders: {}, // gid -> { customerId, subtotal, source, name, billingName, shippingName }
  credits: [], // { customerId, amount }
  discounts: [],
  webhooks: [],
  calls: [],
  emails: [], // what the app sent through Resend: { to, subject, text, reply_to }
};
let seq = 1000;

const rooms = [
  { handle: 'main-room', name: 'Main room', code: 'T', table_count: '21', seats: '4', sort_order: '1' },
  { handle: 'party-room', name: 'Party room', code: 'P', table_count: '4', seats: '4', sort_order: '2' },
  { handle: 'gaming-room', name: 'Gaming room', code: 'G', table_count: '4', seats: '4', sort_order: '3' },
  { handle: 'fancy-room', name: 'Fancy room', code: 'F', table_count: '1', seats: '12', price: '15.0', min_people: '4', sort_order: '4' },
].map(({ handle, ...f }) => ({ handle, capabilities: { publishable: { status: 'ACTIVE' } }, fields: Object.entries(f).map(([key, value]) => ({ key, value })) }));

/** The renderer's Liquid-shaped events as Admin API metaobject nodes (every value a string, like Shopify sends) */
function eventNodes() {
  return lairEvents().map((e) => {
    const out = [];
    for (const [key, v] of Object.entries(e)) {
      if (key === 'system' || key === 'image' || key === 'product' || key === 'link') continue;
      const value = v?.value;
      if (value == null || value === '') continue;
      let text;
      if (Array.isArray(value)) text = JSON.stringify(value);
      else if (typeof value === 'boolean') text = value ? 'true' : 'false';
      else if (typeof value === 'number') text = key === 'entry_fee' ? value.toFixed(1) : String(value);
      else text = String(value);
      out.push({ key, value: text });
    }
    return { handle: e.system.handle, capabilities: { publishable: { status: 'ACTIVE' } }, fields: out };
  });
}

const settingsText = () => fs.readFileSync(path.join(THEME, 'config/settings_data.json'), 'utf8');

function answer(op, query, v) {
  switch (op) {
    case 'LairData':
      return {
        rooms: { nodes: rooms },
        events: { nodes: eventNodes() },
        main: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/150000000001', name: 'Dice Goblin (t5 preview)', files: { nodes: [{ body: { content: settingsText() } }] } }] },
        shop: { name: 'Dice Goblin NZ', shopAddress: { address1: '56/691 Manukau Road', address2: 'Royal Oak', city: 'Auckland', zip: '1023' } },
      };
    case 'Scopes':
      return {
        currentAppInstallation: {
          accessScopes: (state.scopes || ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions', 'write_discounts', 'read_products', 'read_inventory']).map((handle) => ({ handle })),
          app: { title: 'Dice Goblin Lair (fake)' },
        },
        shop: { name: 'Dice Goblin NZ', ianaTimezone: 'Pacific/Auckland' },
      };
    case 'C': {
      const id = String(v.id || '').split('/').pop();
      const tags = state.customers[id];
      return { customer: tags ? { id: v.id, tags } : null };
    }
    // Round 6: the account email guest bookings are matched to, and when accounts were made (years with us)
    case 'CustomerEmail': {
      const id = String(v.id || '').split('/').pop();
      const person = state.people[id];
      if (!state.customers[id] && !person) return { customer: null };
      return { customer: { id: v.id, verifiedEmail: person?.verified !== false, defaultEmailAddress: person?.email ? { emailAddress: person.email } : null } };
    }
    case 'CustomersSince':
      return {
        nodes: (v.ids || []).map((gid) => {
          const id = String(gid).split('/').pop();
          return state.customers[id] || state.people[id] ? { id: gid, createdAt: state.people[id]?.createdAt || '2025-02-01T00:00:00Z' } : null;
        }),
      };
    // Round 6: library copies need read_products and read_inventory; failVariant answers like a store that hasn't
    // approved them yet
    case 'VariantCopies':
      if (state.failVariant) return { __errors: [{ message: 'Access denied for inventoryQuantity field. Required access: `read_inventory` access scope.', extensions: { code: 'ACCESS_DENIED' } }] };
      return {
        nodes: (v.ids || []).map((gid) => {
          const x = state.variants[String(gid).split('/').pop()];
          return x ? { id: gid, inventoryQuantity: x.quantity, inventoryItem: { tracked: x.tracked !== false } } : null;
        }),
      };
    // Round 7: the variants whose barcode or SKU is a scanned code (library scans, the tab's scanner)
    case 'LairVariantByCode': {
      if (state.failVariantCode) return { __errors: [{ message: 'Access denied for productVariants field. Required access: `read_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }] };
      const wanted = [...String(v.query || '').matchAll(/(barcode|sku):"([^"]*)"/g)].map((m) => [m[1], m[2].toUpperCase()]);
      return {
        productVariants: {
          nodes: state.variantCodes.filter((x) => wanted.some(([field, value]) => String(x[field] || '').toUpperCase() === value)).slice(0, 5).map((x) => ({
            id: `gid://shopify/ProductVariant/${x.id}`, title: x.title || 'Default Title', sku: x.sku || null, barcode: x.barcode || null, price: x.price || '0.00',
            availableForSale: x.available !== false, media: { nodes: x.image ? [{ preview: { image: { url: x.image } } }] : [] },
            product: {
              id: `gid://shopify/Product/${x.productId}`, handle: x.handle || '', title: x.productTitle || '', status: x.status || 'ACTIVE', isGiftCard: Boolean(x.giftCard),
              requiresSellingPlan: Boolean(x.sellingPlan), featuredMedia: x.productImage ? { preview: { image: { url: x.productImage } } } : null,
              libraryCode: x.libraryCode ? { value: x.libraryCode } : null,
            },
          })),
        },
      };
    }
    // Round 7: a birthday gift's product code as Shopify sees it: made (discountCodeBasicCreate) and how often it's been used
    case 'LairGiftCodeUse': {
      const made = state.discounts.find((d) => String(d.code || '').toUpperCase() === String(v.code || '').toUpperCase());
      if (!made) return { codeDiscountNodeByCode: null };
      return {
        codeDiscountNodeByCode: {
          id: `gid://shopify/DiscountCodeNode/${made.code}`,
          codeDiscount: { __typename: 'DiscountCodeBasic', status: 'ACTIVE', endsAt: made.endsAt || null, asyncUsageCount: state.discountUses[String(made.code).toUpperCase()] || 0 },
        },
      };
    }
    // Round 6: a customer's orders for the spend report's backfill. Without read_all_orders, Shopify shows the last
    // 60 days only, so this does too.
    case 'CustomerOrders': {
      if (state.failOrders) return { __errors: [{ message: 'Fake: Shopify is having a moment (CustomerOrders)' }] };
      const id = String(v.id || '').split('/').pop();
      if (!state.customers[id] && !state.people[id]) return { customer: null };
      const all = (state.scopes || []).includes('read_all_orders');
      const nodes = Object.entries(state.orders)
        .filter(([, o]) => o.customerId === id && (all || Date.parse(o.createdAt) > Date.now() - 60 * 86400000))
        .sort(([, a], [, b]) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(([gid, o]) => ({
          id: gid, name: o.name, createdAt: o.createdAt, processedAt: o.createdAt, sourceName: o.source || 'web', cancelledAt: o.cancelled ? o.createdAt : null,
          displayFinancialStatus: o.status || 'PAID', subtotalPriceSet: { shopMoney: { amount: (o.subtotal / 100).toFixed(2), currencyCode: 'NZD' } },
        }));
      return { customer: { id: v.id, createdAt: state.people[id]?.createdAt || '2025-02-01T00:00:00Z', orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    case 'Draft': {
      if (state.failCheckout) return { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input'], message: 'Fake: checkout is switched off' }] } };
      const id = `gid://shopify/DraftOrder/${(seq += 1)}`;
      const n = id.split('/').pop();
      state.drafts[id] = { id, status: 'OPEN', orderId: null, input: v.input };
      return { draftOrderCreate: { draftOrder: { id, invoiceUrl: `http://localhost:4180/__checkout/${n}` }, userErrors: [] } };
    }
    case 'DraftStatus':
    case 'DraftOpen': {
      const d = state.drafts[v.id];
      if (!d) return { draftOrder: null };
      return { draftOrder: { id: d.id, status: d.status, ...(op === 'DraftStatus' ? { order: d.orderId ? { id: d.orderId } : null } : {}) } };
    }
    case 'D': {
      const d = state.drafts[v.input?.id];
      if (d && d.status !== 'COMPLETED') d.status = 'DELETED';
      return { draftOrderDelete: { deletedId: v.input?.id || null, userErrors: [] } };
    }
    case 'OrderSpend': {
      const o = state.orders[v.id];
      if (!o) return { order: null };
      return {
        order: {
          id: v.id, name: o.name, sourceName: o.source || 'web', customer: o.customerId ? { id: `gid://shopify/Customer/${o.customerId}` } : null,
          currentSubtotalPriceSet: { shopMoney: { amount: (o.subtotal / 100).toFixed(2), currencyCode: 'NZD' } },
          // round 7: a birthday gift's product code on an order is noticed from these
          discountCodes: o.discountCodes || [], processedAt: o.createdAt || null,
        },
      };
    }
    case 'OrderBuyer': {
      if (state.failBuyer) return { __errors: [{ message: 'Access denied for customer field. This app is not approved to access protected customer data.' }] };
      const o = state.orders[v.id];
      if (!o) return { order: null };
      const person = o.customerId ? state.people[o.customerId] || {} : {};
      return {
        order: {
          id: v.id, name: o.name,
          billingAddress: o.billingName ? { name: o.billingName } : null,
          shippingAddress: o.shippingName ? { name: o.shippingName } : null,
          customer: o.customerId
            ? { id: `gid://shopify/Customer/${o.customerId}`, displayName: person.name || '', defaultEmailAddress: person.email ? { emailAddress: person.email } : null }
            : null,
        },
      };
    }
    // Round 6: who bought a session gift (the order's email and the buyer's first name: protected customer data)
    case 'OrderGiftBuyer': {
      if (state.failBuyer) return { __errors: [{ message: 'Access denied for email field. This app is not approved to access protected customer data.' }] };
      const o = state.orders[v.id];
      if (!o) return { order: null };
      const person = o.customerId ? state.people[o.customerId] || {} : {};
      return {
        order: {
          id: v.id, name: o.name, email: o.email || person.email || null,
          billingAddress: o.billingName ? { firstName: o.billingName.split(/\s+/)[0], name: o.billingName } : null,
          customer: o.customerId
            ? { id: `gid://shopify/Customer/${o.customerId}`, firstName: (person.name || '').split(/\s+/)[0] || null, displayName: person.name || '', defaultEmailAddress: person.email ? { emailAddress: person.email } : null }
            : null,
        },
      };
    }
    case 'Credit': {
      if (state.failCredit) return { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [{ field: ['id'], message: 'Fake: store credit is switched off', code: 'FAKE' }] } };
      const customerId = String(v.id || '').split('/').pop();
      const amount = Math.round(Number(v.creditInput?.creditAmount?.amount || 0) * 100);
      state.credits.push({ customerId, amount, at: Date.now() });
      return { storeCreditAccountCredit: { storeCreditAccountTransaction: { amount: { amount: (amount / 100).toFixed(2) } }, userErrors: [] } };
    }
    case 'Prize':
      if (state.failDiscount) return { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount'], message: 'Fake: discounts are switched off', code: 'FAKE' }] } };
      state.discounts.push(v.discount);
      return { discountCodeBasicCreate: { codeDiscountNode: { id: `gid://shopify/DiscountCodeNode/${(seq += 1)}` }, userErrors: [] } };
    case 'Hooks':
      return { webhookSubscriptions: { nodes: state.webhooks.map((uri, i) => ({ id: `gid://shopify/WebhookSubscription/${i + 1}`, uri })) } };
    case 'Hook':
      state.webhooks.push(v.sub?.uri);
      return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${state.webhooks.length}` }, userErrors: [] } };
    default:
      return null;
  }
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const raw = await body(req);
  try {
    if (url.pathname === '/admin/oauth/access_token' && req.method === 'POST') {
      const p = new URLSearchParams(raw);
      if (p.get('client_secret') !== 'hush') return send(res, 400, { error: 'invalid_client' });
      return send(res, 200, { access_token: 'fake-admin-token', scope: 'read_customers', expires_in: 86399 });
    }
    if (/^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname) && req.method === 'POST') {
      if (req.headers['x-shopify-access-token'] !== 'fake-admin-token') return send(res, 401, { errors: 'Unauthorized' });
      const { query, variables } = JSON.parse(raw || '{}');
      const op = (String(query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1] || '?';
      const entry = { at: new Date().toISOString(), op, variables };
      state.calls.push(entry);
      fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
      if (op === 'Draft' && state.failCheckout === 'http') return send(res, 500, { errors: 'boom' });
      const data = answer(op, query, variables || {});
      if (!data) return send(res, 200, { errors: [{ message: `Fake Admin API: unknown operation ${op}` }] });
      if (data.__errors) return send(res, 200, { errors: data.__errors });
      return send(res, 200, { data });
    }
    // Resend's API: the app's emails land here (the dev entry sends api.resend.com/* to /resend/*)
    if ((url.pathname === '/resend/emails' || url.pathname === '/resend/emails/batch') && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer re_fake') return send(res, 401, { message: 'API key is invalid' });
      const list = url.pathname.endsWith('/batch') ? JSON.parse(raw || '[]') : [JSON.parse(raw || '{}')];
      for (const m of list) state.emails.push({ at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text, reply_to: m.reply_to || null });
      return send(res, 200, url.pathname.endsWith('/batch') ? { data: list.map(() => ({ id: `em_${(seq += 1)}` })) } : { id: `em_${(seq += 1)}` });
    }
    if (url.pathname === '/__fake/emails') return send(res, 200, state.emails);
    if (url.pathname === '/__fake/state') return send(res, 200, { ...state, calls: state.calls.length, emails: state.emails.length });
    if (url.pathname === '/__fake/calls') return send(res, 200, state.calls);
    if (url.pathname === '/__fake/set' && req.method === 'POST') {
      Object.assign(state, JSON.parse(raw || '{}'));
      return send(res, 200, {
        ok: true, failCheckout: state.failCheckout, failCredit: state.failCredit, failDiscount: state.failDiscount, failBuyer: state.failBuyer, failVariant: state.failVariant,
        failOrders: state.failOrders, scopes: state.scopes,
      });
    }
    if (url.pathname === '/__fake/customer' && req.method === 'POST') {
      const { id, tags, name, email, createdAt, verified } = JSON.parse(raw || '{}');
      state.customers[String(id)] = tags || [];
      if (name || email || createdAt || verified != null) {
        state.people[String(id)] = { name: name || '', email: email || '', ...(createdAt ? { createdAt } : {}), ...(verified != null ? { verified } : {}) };
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__fake/variant' && req.method === 'POST') {
      const { id, quantity, tracked } = JSON.parse(raw || '{}');
      state.variants[String(id)] = { quantity: Number(quantity), tracked: tracked !== false };
      return send(res, 200, { ok: true, variant: state.variants[String(id)] });
    }
    if (url.pathname === '/__fake/variant-code' && req.method === 'POST') {
      const x = JSON.parse(raw || '{}');
      state.variantCodes = [...state.variantCodes.filter((y) => String(y.id) !== String(x.id)), x];
      return send(res, 200, { ok: true, variant: x });
    }
    if (url.pathname === '/__fake/discount-use' && req.method === 'POST') {
      const { code, count } = JSON.parse(raw || '{}');
      state.discountUses[String(code || '').toUpperCase()] = Number(count) || 0;
      return send(res, 200, { ok: true, uses: state.discountUses });
    }
    if (url.pathname === '/__fake/order' && req.method === 'POST') {
      const o = JSON.parse(raw || '{}');
      const gid = String(o.id).startsWith('gid://') ? o.id : `gid://shopify/Order/${o.id}`;
      state.orders[gid] = {
        customerId: o.customerId ? String(o.customerId) : null, subtotal: Number(o.subtotal || 0), source: o.source || 'web',
        name: o.name || `#${String(gid).split('/').pop()}`, billingName: o.billingName || '', shippingName: o.shippingName || '',
        // round 6: the order's email (session gifts), when it was made, its financial status and whether it was cancelled
        email: o.email || '', createdAt: o.createdAt || new Date().toISOString(), status: o.status || 'PAID', cancelled: Boolean(o.cancelled),
        // round 7: the discount codes used on it
        discountCodes: Array.isArray(o.discountCodes) ? o.discountCodes.map(String) : [],
      };
      return send(res, 200, { ok: true, gid });
    }
    if (url.pathname === '/__fake/draft-paid' && req.method === 'POST') {
      const { draftId, orderId } = JSON.parse(raw || '{}');
      const d = state.drafts[draftId];
      if (!d) return send(res, 404, { error: 'no such draft' });
      d.status = 'COMPLETED';
      d.orderId = orderId;
      return send(res, 200, { ok: true, draft: d });
    }
    return send(res, 404, { errors: `Fake Admin API: nothing at ${req.method} ${url.pathname}` });
  } catch (error) {
    return send(res, 500, { errors: String(error.stack || error) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake Admin API on http://127.0.0.1:${PORT} (theme ${THEME})`));

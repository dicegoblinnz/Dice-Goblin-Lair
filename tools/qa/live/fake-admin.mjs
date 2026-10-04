// A stand-in for Shopify's Admin API (OAuth token + GraphQL), for the Lair app under `wrangler dev`.
// The dev entry (dev/worker-entry.mjs) sends every https://ep0qiq-rp.myshopify.com/... request here instead.
//
// It answers the app's GraphQL operations by name with the same data the theme preview renders:
//   rooms   = the theme's default rooms (T1-T21, P1-P4, G1-G4, F1 at $15)
//   events  = the mock renderer's lair_event metaobjects (events-mock.mjs: round 4 payment / lock_tables included)
//   theme   = dg-theme-t5's config/settings_data.json (hours, shop tables, prices)
// and keeps draft orders, orders (for orders/paid spend), store credit and discount codes in memory.
//
// Control routes for the test scripts (never part of Shopify):
//   GET  /__fake/state                       everything it holds
//   POST /__fake/set { failCheckout, failCredit }
//   POST /__fake/customer { id, tags }
//   POST /__fake/order { id, customerId, subtotal (cents), source }
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
  customers: {
    7001: ['staff'], // Mo, staff
    7101: [], // Sam Jones, member
    7102: [], // Kiri Smith, a friend who pays a share
    7103: ['gm'], // Ana Rangi, trusted GM
    7104: [], // Leo Tane, player
  },
  drafts: {}, // id -> { id, status, orderId, input }
  orders: {}, // gid -> { customerId, subtotal, source }
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
          accessScopes: ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions', 'write_discounts'].map((handle) => ({ handle })),
          app: { title: 'Dice Goblin Lair (fake)' },
        },
        shop: { name: 'Dice Goblin NZ', ianaTimezone: 'Pacific/Auckland' },
      };
    case 'C': {
      const id = String(v.id || '').split('/').pop();
      const tags = state.customers[id];
      return { customer: tags ? { id: v.id, tags } : null };
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
          id: v.id, sourceName: o.source || 'web', customer: o.customerId ? { id: `gid://shopify/Customer/${o.customerId}` } : null,
          currentSubtotalPriceSet: { shopMoney: { amount: (o.subtotal / 100).toFixed(2), currencyCode: 'NZD' } },
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
      return send(res, 200, { ok: true, failCheckout: state.failCheckout, failCredit: state.failCredit });
    }
    if (url.pathname === '/__fake/customer' && req.method === 'POST') {
      const { id, tags } = JSON.parse(raw || '{}');
      state.customers[String(id)] = tags || [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__fake/order' && req.method === 'POST') {
      const o = JSON.parse(raw || '{}');
      const gid = String(o.id).startsWith('gid://') ? o.id : `gid://shopify/Order/${o.id}`;
      state.orders[gid] = { customerId: o.customerId ? String(o.customerId) : null, subtotal: Number(o.subtotal || 0), source: o.source || 'web' };
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

// Dice Goblin Lair — Cloudflare Worker entry point.
//   /proxy/*                 Shopify app proxy (www.dicegoblin.nz/apps/lair/*), signature checked
//   /webhooks/orders-paid    Shopify webhook, HMAC checked
//   /setup?key=SETUP_KEY     check the connection and (re)register the payment webhook
//   /health                  uptime check
import { Lair } from './lair.js';
import { safeEqual, verifyProxySignature, verifyWebhook } from './shopify.js';

export { Lair };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const lair = (env) => env.LAIR.get(env.LAIR.idFromName('dice-goblin'));

/** Requests from the Worker itself to the Lair's internal routes. The public proxy can never set this header. */
const internalCall = (env, origin, path, body) =>
  lair(env).fetch(new Request(`${origin}/internal/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body }));

/** Shopify puts the shopper's address before its own in X-Forwarded-For; only used for soft rate limits. */
function clientAddress(request) {
  const hops = (request.headers.get('X-Forwarded-For') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length > 1 ? hops[hops.length - 2] : hops[0] || '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/proxy' || url.pathname.startsWith('/proxy/')) {
      const valid = await verifyProxySignature(url.searchParams, env.SHOPIFY_CLIENT_SECRET);
      if (!valid || url.searchParams.get('shop') !== env.SHOP) return json({ error: 'This request did not come through the Dice Goblin store.' }, 401);
      const customers = url.searchParams.getAll('logged_in_customer_id');
      if (customers.length > 1) return json({ error: 'Bad request.' }, 400);
      // The booking pages always send JSON. Another website can't send JSON to the shop without permission,
      // so this stops cross-site tricks. (Set JSON_ONLY = "off" only if Shopify ever stops passing Content-Type on.)
      const type = (request.headers.get('Content-Type') || '').toLowerCase();
      if (request.method !== 'GET' && request.method !== 'HEAD' && !type.startsWith('application/json') && env.JSON_ONLY !== 'off') {
        return json({ error: 'The booking app only accepts JSON requests.' }, 415);
      }
      const path = url.pathname.replace(/^\/proxy/, '') || '/';
      if (/^\/internal(\/|$)/.test(path)) return json({ error: 'Not found' }, 404);
      const inner = new URL(url);
      inner.pathname = path;
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Lair-Customer': customers[0] || '',
        'X-Lair-Client': clientAddress(request),
        'X-Lair-Origin': url.origin,
      });
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
      return lair(env).fetch(new Request(inner.toString(), { method: request.method, headers, body }));
    }

    if (url.pathname === '/webhooks/orders-paid' && request.method === 'POST') {
      const raw = await request.text();
      const valid = await verifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_CLIENT_SECRET);
      if (!valid || request.headers.get('X-Shopify-Shop-Domain') !== env.SHOP) return json({ error: 'Bad webhook signature' }, 401);
      return internalCall(env, url.origin, 'orders-paid', raw);
    }

    if (url.pathname === '/setup' && ['GET', 'POST'].includes(request.method)) {
      // Open https://<worker>/setup?key=<SETUP_KEY> in a browser, or POST with "Authorization: Bearer <SETUP_KEY>".
      const key = url.searchParams.get('key') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.SETUP_KEY || !safeEqual(key, env.SETUP_KEY)) return json({ error: 'Not allowed' }, 403);
      return internalCall(env, url.origin, 'setup', JSON.stringify({ webhookUrl: `${url.origin}/webhooks/orders-paid` }));
    }

    return json({ error: 'Not found' }, 404);
  },
};

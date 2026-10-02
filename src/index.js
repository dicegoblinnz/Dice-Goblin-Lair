// Dice Goblin Lair — Cloudflare Worker entry point.
//   /proxy/*                 Shopify app proxy (www.dicegoblin.nz/apps/lair/*), signature checked
//   /webhooks/orders-paid    Shopify webhook, HMAC checked
//   /setup?key=SETUP_KEY     check the connection and (re)register the payment webhook
//   /health                  uptime check
//   cron (every 10 minutes)  the same health check; results land in the config database's status table
import { Lair } from './lair.js';
import { safeEqual, verifyProxySignature, verifyWebhook } from './shopify.js';
import { withConfig } from './config.js';

export { Lair };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const lair = (env) => env.LAIR.get(env.LAIR.idFromName('dice-goblin'));

/** Requests from the Worker itself to the Lair's internal routes. The public proxy can never set this header. */
const internalCall = (env, origin, path, body) =>
  lair(env).fetch(new Request(`${origin}/internal/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body }));

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain page for anyone who opens the app's own address: what it is, where to book, and whether it's connected. */
async function statusPage(env) {
  let rows = [];
  try {
    if (env.CONFIG) rows = (await env.CONFIG.prepare("SELECT key, value, at FROM status WHERE key IN ('connection', 'proxy')").all()).results;
  } catch {
    rows = [];
  }
  const read = (key) => {
    const row = rows.find((r) => r.key === key);
    try {
      return row ? { ...JSON.parse(row.value), at: row.at } : null;
    } catch {
      return null;
    }
  };
  const connection = read('connection');
  const proxy = read('proxy');
  const shopifyOk = connection?.shopifyLogin === 'ok' && !(connection.missingScopes || []).length;
  const webhookOk = Boolean(connection?.paymentWebhook?.ok);
  const line = (ok, good, bad) => `<li class="${ok ? 'ok' : 'wait'}"><span aria-hidden="true">${ok ? '✓' : '…'}</span>${ok ? good : bad}</li>`;
  const html = `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dice Goblin booking app</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:#1b1512;color:#f6efe6;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem}h1{margin:0 0 .5rem;font-size:1.75rem;line-height:1.15;color:#9be564}p{margin:0 0 1rem;color:#d8cfc4}
a{color:#ffd166}ul{list-style:none;margin:1.25rem 0;padding:0;display:grid;gap:.5rem}li{display:flex;gap:.6rem;align-items:baseline}
li span{display:inline-grid;place-items:center;width:1.4rem;height:1.4rem;border-radius:50%;font-size:.85rem;flex:none}
.ok span{background:#9be564;color:#1b1512}.wait span{background:#4a3f38;color:#f6efe6}small{color:#a89c90}
</style></head><body><main>
<h1>Dice Goblin booking app</h1>
<p>This is the engine behind table bookings and GM games at the Dice Goblin Lair. There's nothing to click here: to book a table, go to <a href="https://www.dicegoblin.nz/pages/book-a-table">dicegoblin.nz</a>.</p>
<ul>
${line(true, 'Booking app is running', '')}
${line(shopifyOk, 'Connected to the Shopify store', 'Waiting for the Shopify app to be installed with its permissions')}
${!shopifyOk && connection?.advice ? `<li class="hint"><span aria-hidden="true"></span><small>${escapeHtml(connection.advice)}</small></li>` : ''}
${line(webhookOk, 'Online payments are reported back to the app', 'Payment notifications not set up yet')}
${line(Boolean(proxy?.seen), 'The website has reached the app through dicegoblin.nz/apps/lair', 'Waiting for the store link (app proxy) to be set up')}
</ul>
<small>${connection?.checkedAt ? `Last checked ${new Date(connection.checkedAt).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'medium', timeStyle: 'short' })}.` : 'Not checked yet; the app checks itself every 10 minutes.'}</small>
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Shopify puts the shopper's address before its own in X-Forwarded-For; only used for soft rate limits. */
function clientAddress(request) {
  const hops = (request.headers.get('X-Forwarded-For') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length > 1 ? hops[hops.length - 2] : hops[0] || '';
}

export default {
  async fetch(request, rawEnv) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    const env = await withConfig(rawEnv);
    if (url.pathname === '/' && request.method === 'GET') return statusPage(env);

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

  /** Cron trigger: keep the payment webhook in place and record the app's health. */
  async scheduled(event, rawEnv, ctx) {
    const env = await withConfig(rawEnv);
    const origin = (env.PUBLIC_URL || 'https://lair.internal').replace(/\/$/, '');
    const webhookUrl = env.PUBLIC_URL ? `${origin}/webhooks/orders-paid` : undefined;
    ctx.waitUntil(internalCall(env, origin, 'maintenance', JSON.stringify({ webhookUrl })));
  },
};

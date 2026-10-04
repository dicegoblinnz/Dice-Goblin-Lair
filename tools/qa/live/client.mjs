// Helpers for talking to the Lair app under wrangler dev the way Shopify does: app proxy requests signed with the
// client secret, POS session tokens (HS256 JWTs, like test/lair.test.js's posToken) and signed orders/paid webhooks.
import { createHmac } from 'node:crypto';

export const WORKER = 'http://127.0.0.1:8787';
export const FAKE = 'http://127.0.0.1:8799';
export const SECRET = 'hush';
export const CLIENT_ID = 'client-id';
export const SHOP = 'ep0qiq-rp.myshopify.com';
export const API = '/apps/liar';

/** Shopify's app proxy signature: hex HMAC-SHA256 of the sorted key=value pairs (repeats joined by commas) */
export function signParams(params) {
  const grouped = {};
  for (const [k, v] of params) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  params.set('signature', createHmac('sha256', SECRET).update(message).digest('hex'));
  return params;
}

/** A signed app proxy URL for a route like 'floor?from=1' */
export function proxyUrl(route, customer = '') {
  const [pathPart, query = ''] = String(route).replace(/^\//, '').split('?');
  const params = new URLSearchParams(query);
  params.set('shop', SHOP);
  params.set('logged_in_customer_id', customer ? String(customer) : '');
  params.set('path_prefix', API);
  params.set('timestamp', String(Math.floor(Date.now() / 1000)));
  return `${WORKER}/proxy/${pathPart}?${signParams(params)}`;
}

/**
 * The visitor's address as Shopify's app proxy forwards it (visitor, then Shopify's hop). The app's soft limit of 20
 * bookings per address per 10 minutes (unit-tested in test/lair.test.js) would trip over a whole QA run from one
 * machine, so every request here comes from its own made-up visitor address.
 */
let visitor = 0;
export function forwardedFor() {
  visitor += 1;
  return `198.18.${(process.pid + Math.floor(visitor / 250)) % 250}.${(visitor % 250) + 1}, 23.227.38.2`;
}

export async function proxy(method, route, { customer = '', body } = {}) {
  const res = await fetch(proxyUrl(route, customer), {
    method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor() }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
  return { status: res.status, data };
}

/** A POS session token, signed like shopify.session.getSessionToken()'s */
export function posToken(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: CLIENT_ID, sub: '42', exp: now + 60, nbf: now - 5, iat: now - 5, jti: `j${Math.random()}`, ...over };
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

export async function pos(method, route, body) {
  const res = await fetch(`${WORKER}/pos/${route}`, {
    method, headers: { Authorization: `Bearer ${posToken()}`, 'Content-Type': 'application/json', Origin: 'https://extensions.shopifycdn.com' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
  return { status: res.status, data, cors: res.headers.get('access-control-allow-origin') };
}

/** A signed orders/paid webhook. order: { id, source_name, line_items: [{ id, price, quantity, properties: [{ name, value }] }], ... } */
export async function webhook(order) {
  const raw = JSON.stringify({ admin_graphql_api_id: `gid://shopify/Order/${order.id}`, ...order });
  const res = await fetch(`${WORKER}/webhooks/orders-paid`, {
    method: 'POST', body: raw,
    headers: { 'X-Shopify-Hmac-Sha256': createHmac('sha256', SECRET).update(raw).digest('base64'), 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Topic': 'orders/paid', 'Content-Type': 'application/json' },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

export async function fake(method, route, body) {
  const res = await fetch(`${FAKE}/__fake/${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

export const results = [];
export function check(name, ok, extra = '') {
  results.push({ name, ok: Boolean(ok), extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  return ok;
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log(`FAILED:\n${failed.map((f) => `  - ${f.name}${f.extra ? `  (${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)})` : ''}`).join('\n')}`);
  return failed.length;
}

// Dice Goblin Lair — Cloudflare Worker entry point.
//   /proxy/*                 Shopify app proxy (www.dicegoblin.nz/apps/liar/*), signature checked. Signed requests
//                            on other paths are served the same way, in case the proxy URL was entered without /proxy.
//   /pos/*                   the POS extension on the counter iPad (today, scan, checkin, checkin-member, share,
//                            tab/:id/added, member): a Shopify POS session token, CORS for its origin
//   /webhooks/orders-paid    Shopify webhook, HMAC checked
//   /webhooks/memberships    Lair Memberships' webhooks (contracts, billing attempts, cards), HMAC checked with its own secret
//   /setup?key=SETUP_KEY     check the connection and (re)register the payment webhook; &memberships=plans also sets up
//                            the library membership plans, the damage charge product and their webhooks
//   /img/<id>                a GM's game picture (public, cached)
//   /ics/<date id>.ics       an event date as a calendar file, for the reminder email's Add to calendar (public)
//   /feeds/<key>.ics         round 13: a followed game's calendar, every date of its events (public; also through the
//                            app proxy at www.dicegoblin.nz/apps/liar/feeds/<key>.ics, which the Our games page uses)
//   /discord/interactions    round 14: the Discord bot's interactions endpoint (Ed25519 signature checked), answered by the
//                            Lair; when the Lair is slow, Discord gets a deferred answer and the Lair's goes in afterwards
//   /health                  uptime check
//   cron (every 10 minutes)  the same health check; results land in the config database's status table
import { Lair } from './lair.js';
import { safeEqual, verifyProxySignature, verifySessionToken, verifyWebhook } from './shopify.js';
import { withConfig } from './config.js';
import { EPHEMERAL, INTERACTION, RESPONSE, deferFor, finishDeferred, verifyDiscord } from './discord.js';

export { Lair };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const lair = (env) => env.LAIR.get(env.LAIR.idFromName('dice-goblin'));

/** Requests from the Worker itself to the Lair's internal routes. The public proxy can never set this header. */
const internalCall = (env, origin, path, body, headers = {}) =>
  lair(env).fetch(new Request(`${origin}/internal/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1', ...headers }, body }));

/** The POS extension runs on Shopify's own extension origin, so its routes answer CORS (the session token is the proof, not cookies). */
const POS_CORS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
/** The POS routes: GET /pos/today, and POST for the rest. /pos/member is round 3's name for scanning a member code.
    /pos/pass-undo { useId } gives a pass's sessions back, the same as the staff page's undo. */
const POS_ROUTES = /^(?:today|scan|checkin|checkin-member|share|member|pass-undo|tab\/[A-Za-z0-9_-]{1,64}\/added)$/;
const withCors = (response) => {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(POS_CORS)) out.headers.set(key, value);
  return out;
};

/**
 * The POS extension's routes (POS_ROUTES). Staff are signed in to Shopify POS, and its session token (Authorization:
 * Bearer …) proves the request came from this shop's POS for this app.
 */
async function posRoute(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: POS_CORS });
  const route = url.pathname.slice('/pos/'.length);
  if (!POS_ROUTES.test(route) || request.method !== (route === 'today' ? 'GET' : 'POST')) return withCors(json({ error: 'Not found' }, 404));
  const token = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  const claims = token ? await verifySessionToken(token, { secret: env.SHOPIFY_CLIENT_SECRET, clientId: env.SHOPIFY_CLIENT_ID, shop: env.SHOP }) : null;
  if (!claims) return withCors(json({ error: 'Sign in to Shopify POS to use this.' }, 401));
  const body = request.method === 'GET' ? '{}' : await request.text();
  return withCors(await internalCall(env, url.origin, `pos/${route}`, body || '{}', { 'X-Lair-Pos-User': String(claims.sub || '') }));
}

/**
 * Discord waits 3 seconds for an answer; past this, the Worker answers "thinking" and puts the Lair's answer in afterwards.
 * (Not exported: workerd treats every export of this module as an entry point, and a number there stops the Worker starting.)
 */
const DISCORD_WAIT_MS = 2400;
const LATE = Symbol('late');

/**
 * Round 14: the Discord bot's interactions (src/discord.js). Discord signs each one (Ed25519, with the app's public key),
 * and anything that doesn't check out gets a 401, which Discord tests for. A PING is answered here; everything else goes
 * to the Lair, whose answer is Discord's. If the Lair takes too long (a cold start, Shopify being slow), Discord gets a
 * deferred answer straight away and the Lair's answer edits it in when it comes (the interaction's token lasts 15 minutes).
 */
async function discordRoute(request, env, ctx, url) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (!env.DISCORD_PUBLIC_KEY) return json({ error: 'The Discord bot is not set up yet.' }, 503);
  const raw = await request.text();
  const ok = await verifyDiscord(raw, request.headers.get('X-Signature-Ed25519'), request.headers.get('X-Signature-Timestamp'), env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('invalid request signature', { status: 401 });
  let interaction;
  try {
    interaction = JSON.parse(raw);
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (interaction?.type === INTERACTION.PING) return json({ type: RESPONSE.PONG });
  // The Lair's answer, or a plain "try again" when it couldn't give one (never a Lair error in Discord's place)
  const shaped = (answer) => (answer && typeof answer.type === 'number'
    ? answer
    : { type: RESPONSE.MESSAGE, data: { content: "⚠️ Something went wrong on Gobgob's side. Try again, or book on dicegoblin.nz.", flags: EPHEMERAL } });
  const work = internalCall(env, url.origin, 'discord/interaction', raw)
    .then((res) => res.json())
    .then(shaped)
    .catch((error) => {
      console.error('Lair: Discord interaction failed', error);
      return shaped(null);
    });
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LATE), Number(env.DISCORD_WAIT_MS) || DISCORD_WAIT_MS);
  });
  const answer = await Promise.race([work, late]);
  clearTimeout(timer);
  if (answer !== LATE) return json(answer);
  ctx?.waitUntil?.(work.then((a) => finishDeferred(env, interaction, a)));
  return json(deferFor(interaction));
}

/**
 * Round 11: the owner's jobs (src/admin.js). A job is a row the owner adds to the config database's admin_jobs table
 * (kind, payload JSON, status 'pending'); each cron run claims up to five pending rows (oldest first), runs each once in
 * the Lair, and writes back 'done' or 'failed' with the result. Only the Cloudflare account can write to that database.
 */
async function runAdminJobs(env, origin) {
  if (!env.CONFIG) return [];
  let rows = [];
  try {
    await env.CONFIG.prepare(
      "CREATE TABLE IF NOT EXISTS admin_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at INTEGER, done_at INTEGER)",
    ).run();
    rows = (await env.CONFIG.prepare("SELECT id, kind, payload FROM admin_jobs WHERE status = 'pending' ORDER BY created_at, id LIMIT 5").all()).results || [];
  } catch (error) {
    console.error('Lair: admin jobs could not be read', error);
    return [];
  }
  const done = [];
  for (const row of rows) {
    // claim it first, so an overlapping run never does it twice
    const claim = await env.CONFIG.prepare("UPDATE admin_jobs SET status = 'running' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!claim?.meta?.changes) continue;
    let status = 'done';
    let result;
    try {
      let payload = {};
      try {
        payload = JSON.parse(row.payload || '{}');
      } catch {
        throw new Error('The payload is not JSON.');
      }
      const res = await internalCall(env, origin, 'admin-job', JSON.stringify({ id: row.id, kind: row.kind, payload }));
      result = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) status = 'failed';
    } catch (error) {
      status = 'failed';
      result = { error: String(error?.message || error) };
    }
    await env.CONFIG.prepare('UPDATE admin_jobs SET status = ?, result = ?, done_at = ? WHERE id = ?')
      .bind(status, JSON.stringify(result ?? null).slice(0, 200000), Date.now(), row.id)
      .run();
    done.push({ id: row.id, status });
  }
  return done;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain page for anyone who opens the app's own address: what it is, where to book, and whether it's connected. */
async function statusPage(env) {
  let rows = [];
  try {
    if (env.CONFIG) rows = (await env.CONFIG.prepare("SELECT key, value, at FROM status WHERE key IN ('connection', 'proxy', 'proxyMiss', 'email')").all()).results;
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
  const proxyMiss = read('proxyMiss');
  const email = read('email');
  const emailOn = Boolean(connection?.email);
  const shopifyOk = connection?.shopifyLogin === 'ok' && !(connection.missingScopes || []).length;
  const webhookOk = Boolean(connection?.paymentWebhook?.ok);
  const proxyOk = Boolean(proxy?.seen);
  const proxyUrl = `${(env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '')}/proxy`;
  const proxyHint = proxyMiss
    ? `Shopify reached the app, but at "${proxyMiss.path}" instead of a booking address. In the Dev Dashboard, set the app proxy URL to ${proxyUrl} and release that version.`
    : 'Shopify admin → Settings → Apps → Dice Goblin Lair should list an app proxy at www.dicegoblin.nz/apps/liar. This line turns green the first time a booking page loads in live mode.';
  const line = (ok, good, bad) => `<li class="${ok ? 'ok' : 'wait'}"><span aria-hidden="true">${ok ? '✓' : '…'}</span>${ok ? good : bad}</li>`;
  const hint = (text) => `<li class="hint"><span aria-hidden="true"></span><small>${escapeHtml(text)}</small></li>`;
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
${!shopifyOk && connection?.advice ? hint(connection.advice) : ''}
${shopifyOk && connection?.featureAdvice ? hint(connection.featureAdvice) : ''}
${line(webhookOk, 'Online payments are reported back to the app', 'Payment notifications not set up yet')}
${line(proxyOk, `The website has reached the app through dicegoblin.nz${escapeHtml(proxy?.prefix || '/apps/liar')}`, 'Waiting for the store link (app proxy) to be set up')}
${!proxyOk && shopifyOk ? hint(proxyHint) : ''}
${emailOn ? line(!email || email.ok, 'Booking confirmation emails are on', `Booking emails are failing: ${escapeHtml(email?.message || 'unknown error')}`) : ''}
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
  async fetch(request, rawEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    const env = await withConfig(rawEnv);

    // GM game pictures: public, never change (a new picture gets a new id), so they're cached at the edge.
    if (request.method === 'GET' && /^\/img\/[A-Za-z0-9_.-]{4,80}$/.test(url.pathname)) {
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const hit = cache ? await cache.match(request) : null;
      if (hit) return hit;
      const res = await lair(env).fetch(new Request(`${url.origin}/internal/img/${url.pathname.slice(5)}`, { headers: { 'X-Lair-Internal': '1' } }));
      if (res.ok && cache) ctx?.waitUntil?.(cache.put(request, res.clone()));
      return res;
    }

    // Round 11: an event date as a calendar file (the reminder email's Add to calendar): public, like the calendar page
    const ics = request.method === 'GET' ? url.pathname.match(/^\/ics\/([A-Za-z0-9._%@-]{3,200})\.ics$/) : null;
    if (ics) return lair(env).fetch(new Request(`${url.origin}/internal/eventics/${ics[1]}`, { headers: { 'X-Lair-Internal': '1' } }));

    // Round 13: a followed game's calendar (the Our games page's Follow), public; the store's app proxy serves the same
    const feed = ['GET', 'HEAD'].includes(request.method) ? url.pathname.match(/^\/feeds\/([a-z0-9-]{1,90})\.ics$/) : null;
    if (feed) return lair(env).fetch(new Request(`${url.origin}/internal/feed/${feed[1]}`, { headers: { 'X-Lair-Internal': '1' } }));

    if (url.pathname.startsWith('/pos/')) return posRoute(request, env, url);

    // Round 14: the Discord bot (Discord's own signature, not Shopify's)
    if (url.pathname === '/discord/interactions') return discordRoute(request, env, ctx, url);

    // Shopify signs every app proxy request. The proxy URL should end in /proxy, but a signed request on any other
    // path is served the same way, so a proxy URL entered without "/proxy" still works.
    const proxyPath = url.pathname === '/proxy' || url.pathname.startsWith('/proxy/');
    const signed = url.searchParams.has('signature') && url.searchParams.has('shop');
    if (proxyPath || signed) {
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
      const path = (proxyPath ? url.pathname.slice('/proxy'.length) : url.pathname) || '/';
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

    if (url.pathname === '/' && request.method === 'GET') return statusPage(env);

    if (url.pathname === '/webhooks/orders-paid' && request.method === 'POST') {
      const raw = await request.text();
      const valid = await verifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_CLIENT_SECRET);
      if (!valid || request.headers.get('X-Shopify-Shop-Domain') !== env.SHOP) return json({ error: 'Bad webhook signature' }, 401);
      return internalCall(env, url.origin, 'orders-paid', raw);
    }

    // Round 10: Lair Memberships (a second Shopify app) signs its webhooks with its own secret
    if (url.pathname === '/webhooks/memberships' && request.method === 'POST') {
      const raw = await request.text();
      const valid = await verifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.MEMBERSHIPS_CLIENT_SECRET);
      if (!valid || request.headers.get('X-Shopify-Shop-Domain') !== env.SHOP) return json({ error: 'Bad webhook signature' }, 401);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return json({ error: 'Bad webhook body' }, 400);
      }
      const event = { topic: request.headers.get('X-Shopify-Topic') || '', webhookId: request.headers.get('X-Shopify-Webhook-Id') || '', payload };
      return internalCall(env, url.origin, 'memberships-webhook', JSON.stringify(event));
    }

    if (url.pathname === '/setup' && ['GET', 'POST'].includes(request.method)) {
      // Open https://<worker>/setup?key=<SETUP_KEY> in a browser, or POST with "Authorization: Bearer <SETUP_KEY>".
      const key = url.searchParams.get('key') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.SETUP_KEY || !safeEqual(key, env.SETUP_KEY)) return json({ error: 'Not allowed' }, 403);
      const testEmail = url.searchParams.get('email') === 'test';
      const memberships = url.searchParams.get('memberships') || null;
      // Round 14: &discord=commands registers the bot's slash commands again now; &discord=sync posts now
      const discord = url.searchParams.get('discord') || null;
      return internalCall(env, url.origin, 'setup', JSON.stringify({
        webhookUrl: `${url.origin}/webhooks/orders-paid`, testEmail, memberships, membershipsUrl: `${url.origin}/webhooks/memberships`, discord,
      }));
    }

    return json({ error: 'Not found' }, 404);
  },

  /** Cron trigger: keep the payment webhook in place and record the app's health. */
  async scheduled(event, rawEnv, ctx) {
    const env = await withConfig(rawEnv);
    const origin = (env.PUBLIC_URL || 'https://lair.internal').replace(/\/$/, '');
    const webhookUrl = env.PUBLIC_URL ? `${origin}/webhooks/orders-paid` : undefined;
    // (Lair Memberships' webhook address is worked out from this one: the same Worker, /webhooks/memberships)
    ctx.waitUntil(internalCall(env, origin, 'maintenance', JSON.stringify({ webhookUrl })));
    // Round 11: and any job the owner queued in the config database
    ctx.waitUntil(runAdminJobs(env, origin));
  },
};

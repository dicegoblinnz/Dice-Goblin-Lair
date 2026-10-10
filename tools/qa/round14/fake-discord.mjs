// LOCAL QA ONLY (round 14): a stand-in for Discord's API, for the Lair app under `wrangler dev`. The dev entry
// (tools/qa/live/dev/worker-entry.mjs) sends every https://discord.com/... request here instead. It answers the calls the
// bot makes the way Discord does (channel messages, threads, forum posts, editing, the slash commands, the interaction
// webhook, the OAuth2 token and @me) and keeps every call.
//
// Control routes (never part of Discord):
//   GET  /__fake/calls            every call so far ({ method, path, body, auth })
//   POST /__fake/reset            forget them
//   POST /__fake/next { status, body }   the next channel call answers with this (a 429, a 403, a 50083 archived thread)
import http from 'node:http';

const PORT = Number(process.env.FAKE_DISCORD_PORT || 8798);
const calls = [];
let next = [];
let n = 0;
const snowflake = () => String(1300000000000000000n + BigInt((n += 1)));

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(status === 204 ? '' : JSON.stringify(body ?? {}));
};

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://fake');
  if (url.pathname === '/__fake/calls') return send(res, 200, calls);
  if (url.pathname === '/__fake/reset') {
    calls.length = 0;
    next = [];
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__fake/next') {
    next.push(JSON.parse(raw || '{}'));
    return send(res, 200, { ok: true });
  }
  const path = url.pathname.replace(/^\/api\/v10/, '');
  let body = raw;
  try {
    body = raw && (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : raw;
  } catch {
    body = raw;
  }
  calls.push({ method: req.method, path, body, auth: req.headers.authorization || '', ua: req.headers['user-agent'] || '' });
  if (path.startsWith('/channels/') && next.length) {
    const out = next.shift();
    return send(res, out.status || 400, out.body || {});
  }
  if (req.method === 'POST' && /^\/channels\/\d+\/threads$/.test(path)) {
    const id = snowflake();
    return send(res, 201, { id, type: 11, name: body?.name, message: { id } });
  }
  const fromMessage = path.match(/^\/channels\/\d+\/messages\/(\d+)\/threads$/);
  if (req.method === 'POST' && fromMessage) return send(res, 201, { id: fromMessage[1], type: 11, name: body?.name });
  if (req.method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) return send(res, 200, { id: snowflake(), content: body?.content || '' });
  if (req.method === 'PATCH' && /^\/channels\/\d+(\/messages\/\d+)?$/.test(path)) return send(res, 200, { id: path.split('/').pop() });
  if (req.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(path)) return send(res, 200, (body || []).map((c, i) => ({ id: String(i + 1), ...c })));
  if (req.method === 'PATCH' && /^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return send(res, 200, { id: snowflake() });
  if (path === '/oauth2/token') return send(res, 200, { access_token: 'fake-access', token_type: 'Bearer', expires_in: 604800, scope: 'identify' });
  if (path === '/oauth2/token/revoke') return send(res, 200, {});
  if (path === '/users/@me') return send(res, 200, { id: '222222222222222222', username: 'ruby', global_name: 'Ruby', discriminator: '0' });
  return send(res, 404, { message: 'Unknown', code: 0 });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake Discord on http://127.0.0.1:${PORT}`));

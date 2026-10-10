// LOCAL QA ONLY (round 14): a stand-in for Discord's API, for the Lair app under `wrangler dev`. The dev entry
// (tools/qa/live/dev/worker-entry.mjs) sends every https://discord.com/... request here instead. It answers the calls the
// bot makes the way Discord does (channel messages, threads, forum posts, editing and deleting, the server's active
// threads, the slash commands, who owns the app, the interaction webhook, the OAuth2 token and @me) and keeps every call.
// Ids are real snowflakes made at the time, and it remembers each channel's messages and the threads, so the bot can look
// for a post it may have made.
//
// Control routes (never part of Discord):
//   GET  /__fake/calls            every call so far ({ method, path, body, auth, ua, status, at })
//   POST /__fake/reset            forget them
//   POST /__fake/next { status, body }   the next channel call answers with this (a 429, a 403, a 50083 archived thread)
import http from 'node:http';

const PORT = Number(process.env.FAKE_DISCORD_PORT || 8798);
/** The Discord app's owner: the QA's Discord user (tools/qa/round14/discord.mjs) */
const OWNER = '222222222222222222';
const APP = '777777777777777777';
const calls = [];
let next = [];
let messages = new Map();
let threads = [];
let deleted = new Set();
let n = 0;
const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt((n += 1) % 4096));
const inChannel = (id) => {
  if (!messages.has(id)) messages.set(id, []);
  return messages.get(id);
};

const send = (res, status, body, call = null) => {
  if (call) call.status = status;
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
    messages = new Map();
    threads = [];
    deleted = new Set();
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
  const call = { method: req.method, path: `${path}${url.search}`, body, auth: req.headers.authorization || '', ua: req.headers['user-agent'] || '', at: Date.now() };
  calls.push(call);
  if (path.startsWith('/channels/') && next.length) {
    const out = next.shift();
    return send(res, out.status || 400, out.body || {}, call);
  }
  let m;
  if (req.method === 'GET' && path === '/applications/@me') return send(res, 200, { id: APP, name: 'Dice Goblin', owner: { id: OWNER } }, call);
  if (req.method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/threads$/))) {
    const id = snowflake();
    threads.push({ id, parent_id: m[1], name: body?.name, type: 11 });
    inChannel(id).push({ id, channel_id: id, author: { id: APP, bot: true }, ...(body?.message || {}) });
    return send(res, 201, { id, type: 11, parent_id: m[1], name: body?.name, message: { id } }, call);
  }
  if (req.method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
    const message = inChannel(m[1]).find((x) => x.id === m[2]);
    if (message?.thread) return send(res, 400, { message: 'A thread has already been created for this message', code: 160004 }, call);
    if (message) message.thread = { id: m[2] };
    threads.push({ id: m[2], parent_id: m[1], name: body?.name, type: 11 });
    return send(res, 201, { id: m[2], type: 11, parent_id: m[1], name: body?.name }, call);
  }
  if (req.method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
    const id = snowflake();
    inChannel(m[1]).push({ id, channel_id: m[1], author: { id: APP, bot: true }, content: body?.content || '', embeds: body?.embeds || [], components: body?.components || [] });
    return send(res, 200, { id, channel_id: m[1], content: body?.content || '' }, call);
  }
  if (req.method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
    return send(res, 200, inChannel(m[1]).filter((x) => !deleted.has(x.id)).slice(-Number(url.searchParams.get('limit') || 50)).reverse(), call);
  }
  if (req.method === 'GET' && /^\/guilds\/\d+\/threads\/active$/.test(path)) return send(res, 200, { threads, members: [] }, call);
  if (req.method === 'PATCH' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
    if (deleted.has(m[2])) return send(res, 404, { message: 'Unknown Message', code: 10008 }, call);
    const message = inChannel(m[1]).find((x) => x.id === m[2]);
    if (message) Object.assign(message, body);
    return send(res, 200, { id: m[2], channel_id: m[1] }, call);
  }
  if (req.method === 'PATCH' && (m = path.match(/^\/channels\/(\d+)$/))) {
    const thread = threads.find((x) => x.id === m[1]);
    if (thread) Object.assign(thread, body);
    return send(res, 200, { id: m[1] }, call);
  }
  if (req.method === 'DELETE' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
    deleted.add(m[2]);
    return send(res, 204, null, call);
  }
  if (req.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(path)) return send(res, 200, (body || []).map((c, i) => ({ id: String(i + 1), ...c })), call);
  if (req.method === 'PATCH' && /^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return send(res, 200, { id: snowflake() }, call);
  if (path === '/oauth2/token') return send(res, 200, { access_token: 'fake-access', token_type: 'Bearer', expires_in: 604800, scope: 'identify' }, call);
  if (path === '/oauth2/token/revoke') return send(res, 200, {}, call);
  if (path === '/users/@me') return send(res, 200, { id: OWNER, username: 'ruby', global_name: 'Ruby', discriminator: '0' }, call);
  return send(res, 404, { message: 'Unknown', code: 0 }, call);
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake Discord on http://127.0.0.1:${PORT}`));

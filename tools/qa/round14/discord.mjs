// LOCAL QA ONLY (round 14): the Discord bot against the real Lair app under `wrangler dev` (workerd, the Durable Object,
// the Worker's Ed25519 check), with Shopify and Discord faked (tools/qa/live/fake-admin.mjs, ./fake-discord.mjs).
//   node tools/qa/round14/keys.mjs && node tools/qa/round14/fake-discord.mjs &  (then tools/qa/live/up.sh)
//   node tools/qa/round14/discord.mjs
import fs from 'node:fs';
import { WORKER, proxy } from '../live/client.mjs';
import { LairTime } from '../../../src/core.js';

const FAKE_DISCORD = 'http://127.0.0.1:8798';
const GUILD = '111111111111111111';
const USER = '222222222222222222';
const SESSIONS = '555555555555555555';
const EVENTS = '666666666666666666';
const ROLE = '888888888888888888';
const time = new LairTime('Pacific/Auckland');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !extra ? '' : `\n     ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}`}`);
  if (!ok) failures += 1;
};

const key = JSON.parse(fs.readFileSync(new URL('./key.json', import.meta.url)));
const privateKey = await crypto.subtle.importKey('jwk', key.privateJwk, { name: 'Ed25519' }, false, ['sign']);
async function send(interaction, { tamper = false } = {}) {
  const body = JSON.stringify(interaction);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(ts + body))).toString('hex');
  const res = await fetch(`${WORKER}/discord/interactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, body: tamper ? `${body} ` : body,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const ix = (type, data, { user = USER, message = null, permissions = '0' } = {}) => ({
  id: String(Date.now()), application_id: '777777777777777777', type, token: `tok-${Date.now()}`, version: 1, guild_id: GUILD, channel_id: '444444444444444444',
  member: { user: { id: user, username: 'ruby' }, permissions, roles: [] }, data, ...(message ? { message } : {}),
});
const command = (name, options = [], o = {}) => ix(2, { id: 'c1', name, type: 1, options }, o);
const click = (customId, o = {}) => ix(3, { custom_id: customId, component_type: o.values ? 3 : 2, ...(o.values ? { values: o.values } : {}), ...(o.resolved ? { resolved: o.resolved } : {}) }, { ...o, message: { id: '999', flags: o.ephemeral ? 64 : 0 } });
const submit = (customId, fields, o = {}) => ix(5, { custom_id: customId, components: Object.entries(fields).map(([k, v], i) => ({ type: 18, id: i + 1, component: { type: 4, id: i + 20, custom_id: k, value: v } })) }, o);
const discordCalls = async () => (await fetch(`${FAKE_DISCORD}/__fake/calls`)).json();
const maintenance = async () => (await fetch(`${WORKER}/__dev/maintenance`, { method: 'POST' })).json();

await fetch(`${FAKE_DISCORD}/__fake/reset`, { method: 'POST' });

// 1. Discord's checks of the endpoint
const ping = await send({ type: 1 });
check(ping.status === 200 && ping.data.type === 1, 'PING gets PONG', ping);
const forged = await send(command('games'), { tamper: true });
check(forged.status === 401, 'a bad signature gets 401', forged);

// 2. a session three days out, by a trusted GM (Ana, 7103), and a small one that fills
const day = time.key(Date.now() + 3 * 24 * 3600_000);
const start = time.at(day, 18 * 60);
const listed = await proxy('POST', 'games', { customer: '7103', body: { title: 'QA Strahd', system: 'D&D 5e', gm: 'Ana', blurb: 'Mists.', seats: 4, tables: ['G1'], start, end: start + 3 * 3600_000 } });
check(listed.status === 200, 'a session is listed', listed);
const gameId = listed.data.game?.id;
const small = await proxy('POST', 'games', { customer: '7103', body: { title: 'QA Tiny', system: 'Mothership', gm: 'Ana', blurb: 'Space.', seats: 2, tables: ['G2'], start, end: start + 3 * 3600_000 } });
const smallId = small.data.game?.id;

// 3. /lair-setup: channels and the role
const panel = await send(command('lair-setup', [], { permissions: '32' }));
check(panel.data.type === 4 && /Discord setup/.test(JSON.stringify(panel.data)), '/lair-setup shows the panel to a manager', panel);
const set1 = await send(click('dg:set:sessions', { permissions: '32', ephemeral: true, values: [SESSIONS], resolved: { channels: { [SESSIONS]: { id: SESSIONS, type: 0 } } } }));
check(set1.data.type === 7 && /TTRPG sessions go to/.test(set1.data.data.content), 'the sessions channel is picked', set1);
await send(click('dg:set:events', { permissions: '32', ephemeral: true, values: [EVENTS], resolved: { channels: { [EVENTS]: { id: EVENTS, type: 0 } } } }));
await send(click('dg:set:role', { permissions: '32', ephemeral: true, values: [ROLE] }));

// 4. /games and a guest's seat
const games = await send(command('games'));
check(games.data.type === 4 && JSON.stringify(games.data).includes('QA Strahd'), '/games lists the session', games);
const modal = await send(click(`dg:seat:${gameId}`));
check(modal.data.type === 9, 'Grab a seat opens the pop-up for a guest', modal);
const seat = await send(submit(modal.data.data?.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: '021 555 0100', friends: '', notes: '' }));
check(seat.data.type === 4 && seat.data.data.embeds?.[0]?.title === "You're in!", 'the seat is booked', seat);

// 5. the maintenance: slash commands registered, posts up (the 2-second catch-up after the booking may have beaten it)
const report = await maintenance();
check(report.discord?.commands?.ok === true, 'the slash commands are registered', report.discord);
await sleep(3000);
const calls = await discordCalls();
check(calls.some((c) => c.method === 'PUT' && c.path === '/applications/777777777777777777/commands' && c.auth === 'Bot fake-bot-token'), 'PUT the commands with the bot token');
const posted = calls.filter((c) => c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages`);
check(posted.some((c) => c.body?.embeds?.[0]?.title === 'QA Strahd'), "the session's post went up", posted.map((c) => c.body?.embeds?.[0]?.title));
check(calls.some((c) => /\/messages\/\d+\/threads$/.test(c.path) && c.body?.name === 'QA Strahd'), 'with its chat thread');
check(calls.every((c) => !c.path.startsWith('/channels') || /^DiscordBot \(/.test(c.ua)), 'every call carries the bot User-Agent');
const floor = await proxy('GET', `floor?from=${Date.now()}&to=${Date.now() + 10 * 24 * 3600_000}`);
const onFloor = floor.data.games?.find((g) => g.id === gameId);
check(onFloor?.taken === 1 && /^https:\/\/discord\.com\/channels\/111111111111111111\/\d+$/.test(onFloor?.discordUrl || ''), 'the floor has the seat and the chat link', onFloor);

// 6. Link Discord from My Lair: the guest seat joins the account
const started = await proxy('POST', 'me/discord/start', { customer: '7201', body: {} });
check(started.status === 200 && started.data.url?.startsWith('https://discord.com/oauth2/authorize?'), 'Link Discord starts', started);
const state = new URL(started.data.url).searchParams.get('state');
const finished = await proxy('POST', 'me/discord/finish', { customer: '7201', body: { code: 'qa-code', state } });
check(finished.status === 200 && finished.data.discord?.linked?.name === 'Ruby' && finished.data.adopted === 1, 'Link Discord finishes and adopts the guest seat', finished);
const me = await proxy('GET', 'me', { customer: '7201' });
check(me.data.seats?.some((s) => s.gameId === gameId), 'the seat is in My Lair now', me.data.seats);
const mine = await send(command('mylair'));
check(JSON.stringify(mine.data).includes('QA Strahd'), '/mylair lists it', mine);

// 7. a full session gets a seat back: the post shows it and the role is pinged
const a = await proxy('POST', 'bookings', { body: { kind: 'gm-seat', gameId: smallId, people: 1, name: 'Sam', email: 'sam@example.com', players: [{ name: 'Sam' }] } });
await proxy('POST', 'bookings', { body: { kind: 'gm-seat', gameId: smallId, people: 1, name: 'Kiri', email: 'kiri@example.com', players: [{ name: 'Kiri' }] } });
await maintenance();
await sleep(3000);
const cancelled = await proxy('POST', `bookings/${a.data.booking?.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
check(cancelled.status === 200, 'staff cancel a seat', cancelled);
await sleep(3500);
const pings = (await discordCalls()).filter((c) => c.method === 'POST' && typeof c.body?.content === 'string' && c.body.content.includes('A seat just opened up'));
check(pings.length === 1 && pings[0].body.content.startsWith(`<@&${ROLE}> A seat just opened up at **QA Tiny**`) && pings[0].body.allowed_mentions?.roles?.[0] === ROLE, 'the role is pinged, once, by itself (no maintenance needed)', pings.map((p) => p.body));

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);

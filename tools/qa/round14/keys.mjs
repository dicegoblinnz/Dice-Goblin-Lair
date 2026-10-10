// LOCAL QA ONLY (round 14): a throwaway Ed25519 key pair standing in for the Discord app's, so the QA run can sign
// interactions the way Discord does. Writes the public key and the fake Discord settings into tools/qa/live/dev/.dev.vars
// (git ignores it) and the private key into ./key.json (git ignores it too). Run before tools/qa/live/up.sh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vars = path.join(here, '..', 'live', 'dev', '.dev.vars');
const example = path.join(here, '..', 'live', 'dev', 'dev.vars.example');

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
fs.writeFileSync(path.join(here, 'key.json'), JSON.stringify({ publicKey, privateJwk }, null, 2));

const base = fs.existsSync(vars) ? fs.readFileSync(vars, 'utf8') : fs.readFileSync(example, 'utf8');
const kept = base.split('\n').filter((line) => line && !line.startsWith('DISCORD_')).join('\n');
fs.writeFileSync(vars, `${kept}
DISCORD_APPLICATION_ID=777777777777777777
DISCORD_PUBLIC_KEY=${publicKey}
DISCORD_BOT_TOKEN=fake-bot-token
DISCORD_CLIENT_SECRET=fake-client-secret
`);
console.log(`Discord test keys written (public key ${publicKey.slice(0, 12)}…)`);

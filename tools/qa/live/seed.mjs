// Members and passes the browser flows need: everyone opens My Lair once (that makes their member record and code),
// then staff issue Sam a Warhammer league pass and make an unclaimed gift pack for Leo.
import fs from 'node:fs';
import { proxy, check, summary } from './client.mjs';

const out = {};
// The first visit (any logged-in page reads GET /me, and the theme sends the account's name): the code has their initials
const names = { 7001: 'Mo Ashgrove', 7101: 'Sam Jones', 7102: 'Kiri Smith', 7103: 'Ana Rangi', 7104: 'Leo Tane' };
for (const id of ['7001', '7101', '7102', '7103', '7104']) {
  const me = await proxy('GET', `me?name=${encodeURIComponent(names[id])}`, { customer: id });
  const initials = names[id].split(' ').map((w) => w[0]).filter((c, i, a) => i === 0 || i === a.length - 1).join('');
  check(`GET /me makes member ${id} with a code from their name`, me.status === 200 && new RegExp(`^${initials}-[A-Z]+-\\d{1,2}$`).test(me.data.member?.code || ''), me.data.member?.code);
  out[id] = { code: me.data.member?.code };
}
// The rest of their details (My Lair's profile form)
for (const [id, name] of Object.entries(names)) {
  const r = await proxy('POST', 'me/profile', { customer: id, body: { name, firstName: name.split(' ')[0], email: `${name.split(' ')[0].toLowerCase()}@example.com` } });
  check(`profile saved for ${name}`, r.status === 200, r.data.member?.code);
}
const sams = await proxy('POST', 'passes', { customer: '7001', body: { label: 'Warhammer league: 10 sessions', sessions: 10, customerId: '7101', pricePaid: 80, note: 'Season 3' } });
check('staff issue Sam a 10-session pass', sams.status === 200 && sams.data.pass?.holder?.customerId === '7101', sams.data.pass?.code);
out.samPass = sams.data.pass;
const gift = await proxy('POST', 'passes', { customer: '7001', body: { label: 'Gift pack: 10 sessions', sessions: 10, holderName: 'Leo Tane', note: 'Birthday present' } });
check('staff make an unclaimed gift pack', gift.status === 200 && !gift.data.pass?.holder?.customerId, gift.data.pass?.code);
out.giftPass = gift.data.pass;
const notStaff = await proxy('POST', 'passes', { customer: '7101', body: { label: 'x', sessions: 1, holderName: 'x' } });
check('a member cannot issue passes', notStaff.status === 403, notStaff.data.error);
fs.writeFileSync(new URL('./seed.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(summary() ? 1 : 0);

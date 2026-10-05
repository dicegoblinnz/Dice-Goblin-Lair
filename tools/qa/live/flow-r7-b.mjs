// Round 7 (backend-b), HTTP only: the staff customer picker; groups and a group's session pass (booking with it, the
// Wallet, check-in, the POS, claiming, archiving); the events editor against the fake's lair_event entries (list, a
// picture through the staged upload the Worker sends itself, create, the sign-up date rule, update, delete, the 503
// before write_metaobjects is approved); staff TTRPG sessions under the GM rules, with a GM invited by email who then
// makes an account; and players staff add (a weekly regular, a reserved weekly seat whose invite is taken up).
import { proxy, pos, fake, check, summary } from './client.mjs';
import { key, addDays, at, sleep } from './r6-time.mjs';

const STAFF = '7001';
const D = addDays(key(Date.now()), 12);
const DAY = (k) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at(k, 12))).replace(',', '');
const emails = async (from, to) => (await fake('GET', 'emails')).slice(from).filter((e) => !to || [].concat(e.to).map((x) => x.toLowerCase()).includes(to.toLowerCase()));
const calls = async (op) => (await fake('GET', 'calls')).filter((c) => c.op === op);

/* 1. The picker: members first, then Shopify customers the Lair hasn't met */
await fake('POST', 'customer', { id: '7301', tags: [], name: 'Huia Ngata', email: 'huia.ngata@example.com', verified: true });
check('the picker is for staff only', (await proxy('GET', 'customers?q=sam', { customer: '7101' })).status === 403);
const short = await proxy('GET', 'customers?q=s', { customer: STAFF });
check('the picker wants 2 letters', short.status === 422 && short.data.error === 'Type at least 2 letters to search.', short.data);
const sams = (await proxy('GET', 'customers?q=sam', { customer: STAFF })).data;
check('Sam Jones (a member) comes first, with his member code', sams.shopify === true && sams.customers?.[0]?.customerId === '7101' && sams.customers[0].member === true && /^SJ-/.test(sams.customers[0].code || ''), sams);
const huia = (await proxy('GET', 'customers?q=huia', { customer: STAFF })).data;
check('Huia is a Shopify customer the Lair hasn\'t met: member: false, no code', huia.customers?.length === 1 && huia.customers[0].member === false && huia.customers[0].code === null && huia.customers[0].name === 'Huia Ngata' && huia.customers[0].email === 'huia.ngata@example.com', huia);
check('the search goes to Shopify quoted', (await calls('LairCustomers')).at(-1)?.variables?.query === '"huia"', (await calls('LairCustomers')).at(-1));

/* 2. A group, its pass, and what its members can do with it */
const league = await proxy('POST', 'groups', { customer: STAFF, body: { name: 'Warhammer League', organiser: { customerId: '7101' }, members: [{ customerId: '7301', name: 'Huia Ngata', email: 'huia.ngata@example.com' }], note: 'Thursday nights' } });
const group = league.data.group || {};
check('staff make a group: Sam organises, Huia (picked) joins', league.status === 200 && group.organiser?.customerId === '7101' && group.members?.length === 2, league.data.error || group);
const huiaMember = group.members?.find((m) => m.customerId === '7301');
check('Huia\'s member record is made from the picker, with a code', /^HN-[A-Z]+-\d{1,2}$/.test(huiaMember?.code || '') && huiaMember.email === 'huia.ngata@example.com', huiaMember);
const dup = await proxy('POST', 'groups', { customer: STAFF, body: { name: 'warhammer league' } });
check('one active group per name', dup.status === 409 && dup.data.error === "There's already a group called Warhammer League.", dup.data);
const made = await proxy('POST', 'passes', { customer: STAFF, body: { label: 'League (r7): 10 sessions', sessions: 10, groupId: group.id } });
const pass = made.data.pass || {};
check('a pass for the group: its code from the group\'s name, its holder the group', made.status === 200 && /^WL-/.test(pass.code || '') && pass.holder?.name === 'Warhammer League' && pass.group?.id === group.id, made.data.error || pass);
const both = await proxy('POST', 'passes', { customer: STAFF, body: { label: 'x', sessions: 1, groupId: group.id, customerId: '7101' } });
check('a pass belongs to a group or a person, not both', both.status === 422 && both.data.error === 'A pass belongs to a group or a person, not both.', both.data);
const wallet = (await proxy('GET', 'me', { customer: '7301' })).data;
check('the pass is in Huia\'s Wallet, with the group', (wallet.passes || []).some((p) => p.code === pass.code && p.group?.name === 'Warhammer League'), wallet.passes);
const booked = await proxy('POST', 'bookings', { customer: '7301', body: { kind: 'table', tables: ['T9'], start: at(D, 17), end: at(D, 19), people: 2, name: 'Huia Ngata', email: 'huia.ngata@example.com', phone: '021 555 0199', usePass: pass.code } });
check('Huia books with the league\'s pass', booked.status === 200 && booked.data.booking?.pass?.code === pass.code, booked.data.error || booked.data.booking);
const leo = await proxy('POST', 'bookings', { customer: '7104', body: { kind: 'table', tables: ['T10'], start: at(D, 17), end: at(D, 19), people: 2, name: 'Leo Tane', email: 'leo@example.com', phone: '021 555 0198', usePass: pass.code } });
check('Leo isn\'t in the group: 403', leo.status === 403 && leo.data.error === "That pass isn't yours. Ask us at the counter.", leo.data);
const card = (await proxy('POST', 'checkin', { customer: STAFF, body: { code: huiaMember?.code } })).data;
check('check-in with Huia\'s member code lists the group\'s pass', (card.passes || []).some((p) => p.code === pass.code && p.group?.id === group.id), card.passes || card);
const scanned = await pos('POST', 'scan', { code: huiaMember?.code });
check('so does the POS', scanned.status === 200 && (scanned.data.passes || []).some((p) => p.code === pass.code && p.group?.name === 'Warhammer League'), scanned.data);
const claim = await proxy('POST', 'me/passes/claim', { customer: '7104', body: { code: pass.code } });
check('a group\'s pass can\'t be claimed', claim.status === 409 && claim.data.error === 'That pass belongs to a group. Ask us at the counter.', claim.data);
await proxy('POST', `groups/${group.id}/update`, { customer: STAFF, body: { status: 'archived' } });
check('archived: it leaves the members\' Wallets', !((await proxy('GET', 'me', { customer: '7301' })).data.passes || []).some((p) => p.code === pass.code));
const found = (await proxy('GET', 'groups?status=archived&q=huia', { customer: STAFF })).data.groups || [];
check('staff still find it (archived, by a member\'s name)', found.length === 1 && found[0].id === group.id && found[0].passes?.[0]?.code === pass.code, found);

/* 3. The events editor */
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const list = await proxy('GET', 'events', { customer: STAFF });
const dnd = (list.data.events || []).find((e) => e.handle === 'dnd-saturday-6pm');
check('GET /events lists the store\'s events, with the calendar\'s repeat tag', list.status === 200 && dnd?.repeatTag === 'Weekly · Saturdays 6pm' && dnd.config?.id === 'dnd-saturday-6pm' && dnd.type === 'rpg' && dnd.capacity === 12, list.data.error || dnd);
check('dates to come first, soonest first', (list.data.events || []).every((e, i, all) => i === 0 || (all[i - 1].next != null && (e.next == null || e.next >= all[i - 1].next)) || e.next == null), (list.data.events || []).map((e) => [e.handle, e.next]));
const pic = await proxy('POST', 'events/pictures', { customer: STAFF, body: { dataUrl: png, alt: 'Board games on a table' } });
const uploads = await fake('GET', 'uploads');
const upload = Object.values(uploads).at(-1);
check('a picture goes up through the staged upload the Worker posts itself', pic.status === 200 && /^gid:\/\/shopify\/MediaImage\/\d+$/.test(pic.data.image?.id || '') && pic.data.image.status === 'UPLOADED' && upload?.size === 70 && upload.names.at(-1) === 'file' && upload.names[0] === 'Content-Type', pic.data.error || { image: pic.data.image, upload });
const start = at(addDays(D, 1), 19);
const created = await proxy('POST', 'events', { customer: STAFF, body: { title: 'Board game swap (r7)', type: 'social', game: 'Board games', start, end: at(addDays(D, 1), 22), repeat: 'weekly', capacity: 12, entryFee: 5, payment: 'store', priceNote: '$5 entry', imageId: pic.data.image?.id, description: 'Bring one, take one.' } });
const ev = created.data.event || {};
check('staff add an event: written to Shopify, handle from the title', created.status === 200 && ev.handle === 'board-game-swap-r7' && ev.repeatTag?.startsWith('Weekly · ') && ev.entryFee === 500 && ev.image?.id === pic.data.image?.id, created.data.error || ev);
const stored = (await fake('GET', 'events')).find((e) => e.handle === 'board-game-swap-r7');
check('the fake keeps what Shopify would: date with its offset, $5.00, "In store", the picture', /^\d{4}-\d{2}-\d{2}T19:00:00\+1[23]:00$/.test(stored?.fields?.starts_at || '') && stored.fields.entry_fee === '5.00' && stored.fields.payment === 'In store' && stored.fields.image === pic.data.image?.id, stored);
const occ = `board-game-swap-r7@${addDays(D, 1)}`;
const joined = await proxy('POST', `events/${encodeURIComponent(occ).replace(/%40/g, '@')}/join`, { customer: '7102', body: { name: 'Kiri Smith', email: 'kiri@example.com', phone: '021 555 0197', people: 2 } });
check('the new event takes sign-ups straight away (the cached events were dropped)', joined.status === 200 && joined.data.join?.status === 'confirmed', joined.data.error || joined.data);
const moved = await proxy('POST', 'events/board-game-swap-r7/update', { customer: STAFF, body: { start: at(addDays(D, 1), 18), end: at(addDays(D, 1), 22) } });
check('a date people signed up for can\'t move', moved.status === 409 && moved.data.error === `People have signed up for ${DAY(addDays(D, 1))}, so that date can't move or go. Cancel their sign-ups on the staff page first, or make the change from a date nobody's signed up for.`, moved.data);
const before = (await calls('LairEventUpdate')).length;
const worded = await proxy('POST', 'events/board-game-swap-r7/update', { customer: STAFF, body: { title: 'Board game swap (r7)', description: 'Bring one, take one, tell us why.', capacity: 1 } });
const sent = (await calls('LairEventUpdate')).slice(before);
check('an update sends only what changed', worded.status === 200 && sent.length === 1 && JSON.stringify(sent[0].variables.metaobject.fields.map((f) => f.key)) === '["description","capacity"]', worded.data.error || sent.map((c) => c.variables));
check('a lower capacity: nobody\'s cancelled, and the notice says so', worded.data.notice === `${DAY(addDays(D, 1))} already has 2 people, more than the new capacity. Nobody's been cancelled.`, worded.data.notice);
const blocked = await proxy('POST', 'events/board-game-swap-r7/delete', { customer: STAFF, body: {} });
check('an event with sign-ups to come can\'t go', blocked.status === 409 && /^People have signed up for /.test(blocked.data.error || ''), blocked.data);
await proxy('POST', `events/joins/${joined.data.join?.id}/cancel`, { customer: STAFF, body: {} });
const deleted = await proxy('POST', 'events/board-game-swap-r7/delete', { customer: STAFF, body: {} });
check('once the sign-ups are cancelled, it goes', deleted.status === 200 && deleted.data.ok === true && !(await fake('GET', 'events')).some((e) => e.handle === 'board-game-swap-r7'), deleted.data);
const late = await proxy('POST', `events/${encodeURIComponent(occ).replace(/%40/g, '@')}/join`, { customer: '7104', body: { name: 'Leo Tane', email: 'leo@example.com', phone: '021 555 0198', people: 1 } });
check('and the Lair\'s events follow', late.status === 404, late.data);
await fake('POST', 'set', { denyEventWrites: true });
const deniedWrite = await proxy('POST', 'events', { customer: STAFF, body: { title: 'Not yet', type: 'other', start } });
check('before write_metaobjects is approved: the plain 503', deniedWrite.status === 503 && deniedWrite.data.error === "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again.", deniedWrite.data);
await fake('POST', 'set', { denyEventWrites: false, denyEventRefs: true });
const plain = (await proxy('GET', 'events', { customer: STAFF })).data.events || [];
check('before read_files: the events still list (pictures by id)', plain.length > 0 && plain.some((e) => e.handle === 'dnd-saturday-6pm'), plain.length);
await fake('POST', 'set', { denyEventRefs: false });

/* 4. Staff sessions follow the GM rules; a GM who isn't a customer is invited by email */
const session = (body) => proxy('POST', 'games', { customer: STAFF, body: { system: 'Mothership', blurb: 'Space horror in a rusty tug.', seats: 4, tables: ['T7'], start: at(D, 18), end: at(D, 21), schedule: 'one-shot', gmFee: 500, ...body } });
const odd = await session({ title: 'Odd time (r7)', gm: 'Mo', start: at(D, 18, 30), end: at(D, 21, 30) });
check('staff sessions start on the hour, like everyone\'s', odd.status === 422 && odd.data.error === 'Bookings start on the hour.', odd.data);
const shop = await session({ title: 'Shop table game (r7)', gm: 'Mo', tables: ['T1'] });
check('the shop tables are open to staff sessions', shop.status === 200 && shop.data.game?.status === 'open', shop.data.error);
const gmShop = await proxy('POST', 'games', { customer: '7103', body: { title: 'Not here (r7)', system: 'Other', gm: 'Ana', blurb: 'x', seats: 3, tables: ['T2'], start: at(D, 18), end: at(D, 21) } });
check('but not to a GM', gmShop.status === 422 && /shop table/.test(gmShop.data.error || ''), gmShop.data);
const emails0 = (await fake('GET', 'emails')).length;
const invited = await session({ title: 'Rua\'s Mothership (r7)', gm: 'Rua', gmEmail: 'Rua.GM@example.com', schedule: 'weekly', tables: ['T7', 'T8'], seats: 6 });
const g = invited.data.game || {};
check('a GM who isn\'t a customer: invited, and the game waits on that email', invited.status === 200 && invited.data.invited === true && invited.data.notice === 'Gobgob emailed Rua.GM@example.com to make an account. The game joins their account when they log in with that email.', invited.data.error || invited.data);
await sleep(800);
const invite = (await emails(emails0, 'rua.gm@example.com'))[0];
check('the GM invite: "You\'re running <title> at the Dice Goblin Lair"', invite?.subject === "You're running Rua's Mothership (r7) at the Dice Goblin Lair" && invite.text.includes("Kia ora Rua, the Dice Goblin team has put Rua's Mothership (r7) on the games board for you.") && invite.text.includes('Make your Dice Goblin account with this email (Rua.GM@example.com)') && invite.text.includes('Happy GMing!'), invite?.subject);
let staffFloor = (await proxy('GET', `floor?from=${at(D, 0)}&to=${at(addDays(D, 1), 0)}`, { customer: STAFF })).data;
check('staff see it waiting for Rua', staffFloor.games?.find((x) => x.id === g.id)?.gmAccount === 'invited' && staffFloor.games.find((x) => x.id === g.id).gmEmail === 'Rua.GM@example.com', staffFloor.games?.find((x) => x.id === g.id));

/* 5. Players staff add: a weekly regular, and a reserved weekly seat whose invite is taken up */
const emails1 = (await fake('GET', 'emails')).length;
const kiri = await proxy('POST', `games/${g.id}/players`, { customer: STAFF, body: { customerId: '7102', name: 'Kiri Smith', email: 'kiri@example.com', people: 1, weekly: true } });
check('Kiri, every week: a regular from now on', kiri.status === 200 && kiri.data.regular?.customerId === '7102' && kiri.data.regular.seriesId === g.seriesId && kiri.data.invite === null, kiri.data.error || kiri.data);
const mereana = await proxy('POST', `games/${g.id}/players`, { customer: STAFF, body: { name: 'Mereana Rawiri', email: 'mereana.r7b@example.com', people: 1, weekly: true } });
check('Mereana, no account: a reserved seat and an invite', mereana.status === 200 && mereana.data.invite?.email === 'mereana.r7b@example.com' && mereana.data.booking?.customerId === null, mereana.data.error || mereana.data);
await sleep(800);
check('Kiri gets "You\'re a regular" from the team', (await emails(emails1, 'kiri@example.com')).some((e) => e.subject === "You're a regular: Rua's Mothership (r7)" && e.text.includes("the Dice Goblin team has saved your seat at Rua's Mothership (r7) with GM Rua every week.")));
check('Mereana\'s confirmation says her account keeps the seat every week', (await emails(emails1, 'mereana.r7b@example.com')).some((e) => e.text.includes("It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week.")));
check('Rua hears about both new players at the invited address', (await emails(emails1, 'rua.gm@example.com')).filter((e) => /^New player for Rua's Mothership \(r7\)/.test(e.subject)).length === 2);
staffFloor = (await proxy('GET', `floor?from=${at(D, 0)}&to=${at(addDays(D, 1), 0)}`, { customer: STAFF })).data;
check('staff see Mereana\'s invite on the session', JSON.stringify(staffFloor.games?.find((x) => x.id === g.id)?.invites) === JSON.stringify([{ id: mereana.data.invite?.id, name: 'Mereana Rawiri', email: 'mereana.r7b@example.com', people: 1 }]), staffFloor.games?.find((x) => x.id === g.id)?.invites);
// Rua and Mereana make their accounts with those emails and open My Lair
await fake('POST', 'customer', { id: '7302', tags: [], name: 'Rua Tamati', email: 'rua.gm@example.com', verified: true });
await fake('POST', 'customer', { id: '7303', tags: [], name: 'Mereana Rawiri', email: 'Mereana.R7b@example.com', verified: true });
const rua = (await proxy('GET', `me?name=${encodeURIComponent('Rua Tamati')}`, { customer: '7302' })).data;
check('Rua logs in with that email: the game is in Games I run', (rua.games || []).some((x) => x.id === g.id) && (rua.games || []).every((x) => x.seriesId === g.seriesId), (rua.games || []).map((x) => x.title));
staffFloor = (await proxy('GET', `floor?from=${at(D, 0)}&to=${at(addDays(D, 1), 0)}`, { customer: STAFF })).data;
check('and staff see it on Rua\'s account', staffFloor.games?.find((x) => x.id === g.id)?.gmAccount === 'linked');
const mereanaMe = (await proxy('GET', `me?name=${encodeURIComponent('Mereana Rawiri')}`, { customer: '7303' })).data;
check('Mereana logs in with that email: a regular, with her reserved seat', (mereanaMe.series || []).some((x) => x.seriesId === g.seriesId) && (mereanaMe.seats || []).some((x) => x.ref === mereana.data.booking?.ref), { series: mereanaMe.series, seats: (mereanaMe.seats || []).map((x) => x.ref) });
const stop = await proxy('POST', `series/${g.seriesId}/leave`, { customer: STAFF, body: { customerId: '7102' } });
check('staff stop Kiri being a regular', stop.status === 200 && stop.data.ok === true, stop.data);
const again = await proxy('POST', `series/${g.seriesId}/leave`, { customer: STAFF, body: { customerId: '7102' } });
check('and she\'s not a regular any more', again.status === 404 && again.data.error === "They're not a regular at that game.", again.data);
// Tidy up: the sessions made here, so later runs and flows find the tables free
for (const id of [shop.data.game?.id, g.id]) if (id) await proxy('POST', `games/${id}/update`, { customer: STAFF, body: { status: 'cancelled', scope: 'series' } });

/* 6. Without protected customer data, the picker finds Lair members only (last: the Lair then waits 10 minutes to ask again) */
await fake('POST', 'set', { denyCustomers: true });
const membersOnly = (await proxy('GET', 'customers?q=huia', { customer: STAFF })).data;
check('protected customer data not approved: shopify: false, Lair members only', membersOnly.shopify === false && membersOnly.customers?.length === 1 && membersOnly.customers[0].member === true, membersOnly);
await fake('POST', 'set', { denyCustomers: false });

process.exit(summary() ? 1 : 0);

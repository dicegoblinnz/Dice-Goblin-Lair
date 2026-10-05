// Round 6 (e): joining a TTRPG session without an account. Tama books a seat as a guest (name, email, phone, players,
// notes): a ticket code for the QR, a confirmation that says how to make an account, and the GM is emailed his details.
// A member's seat emails the GM too; a game with no GM email emails the staff. When Tama makes an account with that
// email (verified by Shopify) and opens My Lair, the seat is his, and its stamps follow. Also: a staff hold's game.
import { proxy, fake, check, summary } from './client.mjs';
import { key, addDays, at, sleep } from './r6-time.mjs';

const TAMA = '7214';
const STAFF = '7001';
const D = addDays(key(Date.now()), 10);
const emailsSince = async (from, to) => (await fake('GET', 'emails')).slice(from).filter((e) => !to || [].concat(e.to).includes(to));

/* 1. Ana lists a session; a guest joins */
const listed = await proxy('POST', 'games', { customer: '7103', body: { title: 'Blades in the Dark (r6)', system: 'Blades in the Dark', gm: 'Ana', email: 'ana@example.com', blurb: 'Scoundrels in a haunted city.', seats: 4, tables: ['T17'], start: at(D, 18), end: at(D, 21), gmFee: 500 } });
const game = listed.data.game;
check('Ana lists a session (open straight away)', listed.status === 200 && game?.status === 'open', listed.data.error);
const seat = (body, customer = '') => proxy('POST', 'bookings', { customer, body: { kind: 'gm-seat', gameId: game.id, people: 1, ...body } });
const noEmail = await seat({ name: 'Tama Walker', email: '' });
check('a guest needs a real email', noEmail.status === 422 && noEmail.data.error === 'Add an email so we can send your confirmation.', noEmail.data);
const longPhone = await seat({ name: 'Tama Walker', email: 'tama.w@example.com', phone: '0'.repeat(31) });
check('a phone number is up to 30 characters', longPhone.status === 422, longPhone.data);
const emails0 = (await fake('GET', 'emails')).length;
const guest = await seat({ people: 2, name: 'Tama Walker', email: 'tama.w@example.com', phone: '021 555 0142', notes: 'New to Blades, keen to learn', players: [{ name: 'Tama Walker', character: 'Silver' }, { name: 'Ruby', character: '' }] });
const booking = guest.data.booking || {};
check('the guest has a seat with its own ticket code (the QR)', guest.status === 200 && booking.kind === 'gm-seat' && booking.status === 'confirmed' && /^TW-[A-Z]+-\d{1,2}$/.test(booking.ref || '') && booking.ticketCode === booking.ref && booking.amount === 3000, guest.data.error || booking);
await sleep(800);
const toGm = (await emailsSince(emails0, 'ana@example.com'))[0];
check('the GM is emailed: "New player for <title>, <when>: <name>"', toGm && /^New player for Blades in the Dark \(r6\), .+: Tama Walker$/.test(toGm.subject), toGm?.subject);
check('with the player\'s details, the seats left, and that they pay at the counter', toGm && ['tama.w@example.com', '021 555 0142', 'Tama Walker (Silver), Ruby', 'New to Blades, keen to learn', 'They pay at the counter when they arrive.'].every((x) => toGm.text.includes(x)) && /Seats left: +2 of 4/.test(toGm.text) && toGm.reply_to === 'tama.w@example.com', toGm?.text?.slice(0, 500));
const toGuest = (await emailsSince(emails0, 'tama.w@example.com'))[0];
check('the guest\'s confirmation says their seats join an account made with this email', toGuest && toGuest.text.includes('Make an account with this email any time, and your seats will show up in My Lair.') && toGuest.text.includes(booking.ref), toGuest?.subject);

/* 2. A member's seat emails the GM too; join-series still needs an account */
const emails1 = (await fake('GET', 'emails')).length;
const kiri = await seat({ name: 'Kiri Smith', email: 'kiri@example.com' }, '7102');
await sleep(800);
check('a member\'s seat: the GM hears too', kiri.status === 200 && (await emailsSince(emails1, 'ana@example.com')).some((e) => /: Kiri Smith$/.test(e.subject)), kiri.data.error);
check('the member\'s own confirmation has no "make an account" line', !(await emailsSince(emails1, 'kiri@example.com')).some((e) => e.text.includes('Make an account')));
const series = await proxy('POST', `games/${game.id}/join-series`, { body: { people: 1, name: 'Tama Walker', email: 'tama.w@example.com' } });
check('"save my seat every week" still needs an account (401)', series.status === 401, series.data);

/* 3. No GM email on file: the staff get it */
const quiet = await proxy('POST', 'games', { customer: '7103', body: { title: 'Pirate Borg (r6)', system: 'Pirate Borg', gm: 'Ana', blurb: 'Arr.', seats: 3, tables: ['T16'], start: at(D, 18), end: at(D, 21), gmFee: 0 } });
const emails2 = (await fake('GET', 'emails')).length;
const mereSeat = await proxy('POST', 'bookings', { body: { kind: 'gm-seat', gameId: quiet.data.game?.id, people: 1, name: 'Mere Tawhiri', email: 'mere.t@example.com' } });
await sleep(800);
const toStaff = (await emailsSince(emails2, 'staff@dicegoblin.test')).find((e) => /^New player for Pirate Borg \(r6\)/.test(e.subject));
check('a game with no GM email: the staff get the new player instead', mereSeat.status === 200 && toStaff && /There's no email on file for the GM/.test(toStaff.text), toStaff?.subject || mereSeat.data.error);

/* 4. Tama makes an account with that email: the seat is his on My Lair, and its stamps follow */
await proxy('POST', 'checkin', { customer: STAFF, body: { code: booking.ref, force: true } });
await fake('POST', 'customer', { id: TAMA, tags: [], name: 'Tama Walker', email: 'Tama.W@example.com', verified: true });
await fake('POST', 'customer', { id: '7215', tags: [], name: 'Nosy Parker', email: 'nosy.p@example.com', verified: true });
await proxy('POST', 'me/profile', { customer: '7215', body: { name: 'Nosy Parker', email: 'tama.w@example.com' } });
const nosy = (await proxy('GET', 'me', { customer: '7215' })).data;
check('someone who types Tama\'s email into their profile gets nothing', (nosy.seats || []).length === 0, (nosy.seats || []).map((s) => s.ref));
const me = (await proxy('GET', `me?name=${encodeURIComponent('Tama Walker')}`, { customer: TAMA })).data;
const mine = (me.seats || []).find((s) => s.ref === booking.ref);
check('on GET /me the guest seat joins his account (by his verified account email, any case)', Boolean(mine) && mine.gameTitle === 'Blades in the Dark (r6)', (me.seats || []).map((s) => s.ref));
check('its stamps follow: 2 people, checked in', me.loyalty?.stamps === 2 && me.loyalty.recent?.[0]?.title === 'Blades in the Dark (r6)', me.loyalty);
const calls = (await fake('GET', 'calls')).filter((c) => c.op === 'CustomerEmail' && c.variables?.id === `gid://shopify/Customer/${TAMA}`).length;
await proxy('GET', 'me', { customer: TAMA });
check('his account email is asked once a day, not every visit', (await fake('GET', 'calls')).filter((c) => c.op === 'CustomerEmail' && c.variables?.id === `gid://shopify/Customer/${TAMA}`).length === calls, calls);

/* 5. Calendar sub-categories: a staff hold's game */
const block = await proxy('POST', 'blocks', { customer: STAFF, body: { tables: 'T21', start: at(D, 12), end: at(D, 15), label: 'Pokémon pre-release', type: 'tournament', game: 'Pokémon' } });
const floor = (await proxy('GET', `floor?from=${at(D, 0)}&to=${at(addDays(D, 1), 0)}`)).data;
const shown = (floor.blocks || []).find((b) => b.id === block.data.block?.id);
check('a staff hold takes a game, and the public floor carries it (with the public label)', block.status === 200 && block.data.block.game === 'Pokémon' && shown?.game === 'Pokémon' && shown.label === 'Tournament', shown);
await proxy('POST', `blocks/${block.data.block?.id}/delete`, { customer: STAFF, body: {} });

process.exit(summary() ? 1 : 0);

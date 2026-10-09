// Round 11, Warhammer game tables (contract v11-warhammer), HTTP only (no browser), on the real Worker and the fake Admin
// API, through the signed app proxy. Mo (9 Oct, 7pm): "people inside the Warhammer group can book their spots with the
// code of Thier opponent or their email to help them join us. They can choose a specific table as well but it needs to
// be two at a time ... set the fee to $10 per person."
//   1. staff make tonight's "Warhammer night (r11)" with the events editor: T8-T21 held, six pairs (T16-T17 the painting
//      station), $10 in store; the floor's gameSpots lists the pairs, all free
//   2. the 422s and 409s, word for word: the size, a pair that isn't one, a code nobody has, an email that isn't one, your
//      own code or email, someone twice, the number of players; nothing saved
//   3. 1 v 1: Wiremu picks T12 + T13 with Aroha's member code; 2 v 2: Wiremu's friend Ngaio picks the first free pair with
//      a teammate's code and two emails, one a member's (linked) and one nobody's (invited); a taken pair is refused
//   4. the emails (fake Resend): each booker's says who's playing; every other player with an email gets one (who booked,
//      when, which tables, "$10 a person, paid at the counter"; the invite says to make a free account with that email)
//   5. My Lair: the booker sees the players with their emails; Aroha sees "playing in Wiremu's game" with her $10 and
//      no emails; the invited player makes an account with that email and the game is in their My Lair
//   6. check-in: Aroha's member code at the staff page finds the game (playerOf, her share on her total); at the POS her
//      row is her own share: checking it in checks the game in and the cart line is her $10; paying it (her account on
//      the order) pays her part only
import { proxy, pos, fake, webhook, check, summary } from './client.mjs';
import { key } from './r6-time.mjs';

const STAFF = '7001';
const WIREMU = '7901'; // books 1 v 1
const AROHA = '7902'; // his opponent, by member code
const NGAIO = '7903'; // books 2 v 2
const TIPENE = '7904'; // Ngaio's teammate, by member code
const MEREANA = '7905'; // an opponent named by her email (a member: linked)
const INVITED = 'rawiri.r11@example.com'; // an opponent named by an email nobody has: invited
const RAWIRI = '7906'; // …who makes his account with it
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [id, name] of [[WIREMU, 'Wiremu Tane'], [AROHA, 'Aroha Hura'], [NGAIO, 'Ngaio Rau'], [TIPENE, 'Tipene Kauri'], [MEREANA, 'Mereana Pou']]) {
  await fake('POST', 'customer', { id, tags: [], name, email: `${name.split(' ')[0].toLowerCase()}.r11@example.com` });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const codes = Object.fromEntries(await Promise.all([[WIREMU, 'wiremu'], [AROHA, 'aroha'], [NGAIO, 'ngaio'], [TIPENE, 'tipene'], [MEREANA, 'mereana']].map(async ([id, n]) => [n, (await me(id)).member?.code])));
check('setup: everyone has a member code', Object.values(codes).every(Boolean), codes);

/* 1. tonight's Warhammer night, made with the events editor */
const today = key(Date.now());
const start = Math.ceil(Date.now() / 1800000) * 1800000 + 1800000;
const end = start + 3 * 3600000;
const made = await proxy('POST', 'events', {
  customer: STAFF,
  body: { title: `Warhammer night r11 ${today}`, type: 'wargame', game: 'Warhammer', start, end, tables: 'T8-T21', lockTables: true, gameTables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entryFee: 10, payment: 'store', description: '1 v 1 or 2 v 2 on a pair of tables.' },
});
const handle = made.data.event?.handle;
check('1: staff make tonight\'s Warhammer night (T8-T21 held, six pairs, $10 in store)', made.status === 200 && Boolean(handle), made.data.error || made.data);
const OCC = `${handle}@${key(start)}`;
const floor = (await proxy('GET', `floor?from=${start - 3600000}&to=${end + 3600000}`)).data;
check('1: the floor lists the date\'s six pairs, all free (gameSpots), and eventSpots as before', JSON.stringify((floor.gameSpots?.[OCC] || []).map((s) => [s.id, s.label, s.free])) === JSON.stringify(['T8+T9', 'T10+T11', 'T12+T13', 'T14+T15', 'T18+T19', 'T20+T21'].map((id) => [id, id.replace('+', ' + '), true])) && floor.eventSpots?.[OCC]?.total === 6, { spots: floor.gameSpots?.[OCC], eventSpots: floor.eventSpots?.[OCC] });
const reserve = (body, who = WIREMU, name = 'Wiremu Tane') => proxy('POST', `events/${OCC}/reserve`, { customer: who, body: { name, email: `${name.split(' ')[0].toLowerCase()}.r11@example.com`, people: 2, pay: 'day', ...body } });
const bookings = async () => ((await proxy('GET', `floor?from=${start - 3600000}&to=${end + 3600000}`, { customer: STAFF })).data.bookings || []).filter((b) => b.occurrenceId === OCC && b.status !== 'cancelled');

/* 2. the messages */
check('2: 3 people: 422', said(await reserve({ people: 3, players: [] })) === '422 A game table is for 1 v 1 (2 players) or 2 v 2 (4 players).');
check('2: the painting station: 422', said(await reserve({ spot: 'T16+T17', players: [{ code: codes.aroha }] })) === "422 T16 + T17 isn't one of this date's game tables. Pick a pair from the list.");
check('2: a code nobody has: 422, as typed in capitals', said(await reserve({ players: [{ code: 'zz-nope-9' }] })) === "422 Gobgob doesn't know the member code ZZ-NOPE-9. Check it, or use their email instead.");
check('2: an email that isn\'t one: 422', said(await reserve({ players: [{ email: 'aroha@example' }] })) === "422 aroha@example doesn't look like an email address. Check it, or use their member code.");
check('2: his own code: 422', said(await reserve({ players: [{ code: codes.wiremu.toLowerCase() }] })) === "422 That's your own member code. Add the people you're playing with.");
check('2: his own email: 422', said(await reserve({ players: [{ email: 'WIREMU.r11@example.com' }] })) === "422 That's your own email. Add the people you're playing with.");
check('2: 2 v 2 with no players: 422', said(await reserve({ people: 4 })) === '422 Add the other 3 players: a member code or an email each.');
check('2: someone twice (her code and her email): 422 with her name', said(await reserve({ people: 4, players: [{ code: codes.aroha }, { email: 'aroha.r11@example.com' }, { email: INVITED }] })) === '422 Aroha Hura is on the list twice.');
check('2: nothing was saved', (await bookings()).length === 0);

/* 3. 1 v 1 on a pair picked; 2 v 2 on the first free pair; a taken pair */
const emails0 = (await fake('GET', 'emails')).length;
const one = await reserve({ spot: 't12 + t13', players: [{ code: codes.aroha.toLowerCase() }] });
const B1 = one.data.booking || {};
check('3: 1 v 1 with Aroha\'s code on T12 + T13: 2 people, $20, split, Aroha a member opponent', one.status === 200 && B1.tables?.join() === 'T12,T13' && B1.people === 2 && B1.amount === 2000 && B1.split === true && B1.gameSize === '1 v 1' && B1.gamePlayers?.length === 1 && B1.gamePlayers[0].name === 'Aroha Hura' && B1.gamePlayers[0].role === 'opponent' && B1.gamePlayers[0].member === true, one.data.error || B1);
const two = await reserve({ people: 4, players: [{ code: codes.tipene }, { email: 'mereana.r11@example.com' }, { email: INVITED }] }, NGAIO, 'Ngaio Rau');
const B2 = two.data.booking || {};
check('3: 2 v 2 on the first free pair (T8 + T9): $40, Tipene the teammate, Mereana linked by her email, Rawiri invited', two.status === 200 && B2.tables?.join() === 'T8,T9' && B2.amount === 4000 && JSON.stringify(B2.gamePlayers?.map((p) => [p.name, p.role, p.member])) === JSON.stringify([['Tipene Kauri', 'teammate', true], ['Mereana Pou', 'opponent', true], ['Invited player', 'opponent', false]]) && B2.gamePlayers[2].email === INVITED, two.data.error || B2);
check('3: a taken pair: 409 with the words', said(await reserve({ spot: 'T12+T13', players: [{ email: 'friend.r11@example.com' }] }, TIPENE, 'Tipene Kauri')) === '409 T12 + T13 has just been reserved. Pick another pair of tables.');
const after = (await proxy('GET', `floor?from=${start - 3600000}&to=${end + 3600000}`)).data;
check('3: the floor says which pairs are taken now', JSON.stringify((after.gameSpots?.[OCC] || []).filter((s) => !s.free).map((s) => s.id)) === JSON.stringify(['T8+T9', 'T12+T13']) && after.eventSpots?.[OCC]?.taken === 2, after.gameSpots?.[OCC]);

/* 4. the emails */
await wait(600);
const sent = (await fake('GET', 'emails')).slice(emails0);
const to = (addr) => sent.filter((e) => [].concat(e.to).includes(addr));
const wiremuMail = to('wiremu.r11@example.com')[0];
check('4: Wiremu\'s confirmation says who\'s playing and that each pays their own', wiremuMail && /Game: +1 v 1\n/.test(wiremuMail.text) && /Playing: +You against Aroha Hura\n/.test(wiremuMail.text) && /Each player pays their own \$10 at the counter\./.test(wiremuMail.text), wiremuMail ? wiremuMail.text.slice(0, 500) : sent.map((e) => e.to));
const arohaMail = to('aroha.r11@example.com')[0];
check('4: Aroha gets one email: Wiremu booked a 1 v 1 with her, when, T12 + T13, "$10 a person, paid at the counter"', to('aroha.r11@example.com').length === 1 && arohaMail.subject.startsWith(`Warhammer night r11 ${today} with Wiremu: `) && /Kia ora Aroha, Wiremu Tane has booked a 1 v 1 game with you/.test(arohaMail.text) && /Where: +Tables T12 \+ T13\n/.test(arohaMail.text) && /Fee: +\$10 a person, paid at the counter\n/.test(arohaMail.text) && /Give your member code at the counter/.test(arohaMail.text), arohaMail ? arohaMail.text.slice(0, 600) : 'no email');
const invite = to(INVITED)[0];
check('4: the invited player\'s email says to make a free account with that email so the game shows up in My Lair', invite && /Kia ora there, Ngaio Rau has booked a 2 v 2 game with you/.test(invite.text) && new RegExp(`Make your free Dice Goblin account with this email \\(${INVITED.replace(/\./g, '\\.')}\\) and the game shows up in My Lair`).test(invite.text) && /Fee: +\$10 a person, paid at the counter\n/.test(invite.text), invite ? invite.text.slice(0, 600) : 'no email');
check('4: Tipene (teammate) and Mereana (linked) hear too; nobody hears twice', to('tipene.r11@example.com').length === 1 && /You're on Ngaio's team\./.test(to('tipene.r11@example.com')[0].text) && to('mereana.r11@example.com').length === 1 && to(INVITED).length === 1, sent.map((e) => e.to));
check('4: a player\'s email never shows another player\'s email', !/rawiri\.r11@example\.com/.test(to('mereana.r11@example.com')[0]?.text || 'x') && /an invited player/.test(to('mereana.r11@example.com')[0]?.text || ''), to('mereana.r11@example.com')[0]?.text?.slice(0, 600));

/* 5. My Lair */
const ngaioGame = ((await me(NGAIO)).bookings || []).find((b) => b.id === B2.id);
check('5: Ngaio (the booker) sees 2 v 2 and the players, with the email she typed', ngaioGame?.gameSize === '2 v 2' && ngaioGame.gamePlayers?.[2]?.email === INVITED && !ngaioGame.playerOf, ngaioGame);
const arohaMine = await me(AROHA);
const arohaGame = (arohaMine.bookings || []).find((b) => b.id === B1.id);
check('5: Aroha\'s My Lair: Wiremu\'s game (playerOf), T12 + T13, her $10 at the counter, her code as the ticket, no cancelling', arohaGame && arohaGame.playerOf?.name === 'Wiremu' && arohaGame.canCancel === false && arohaGame.tables?.join() === 'T12,T13' && arohaGame.amount === 1000 && arohaGame.due === 1000 && arohaGame.ticketCode === codes.aroha && arohaGame.title === `Warhammer night r11 ${today}`, arohaGame);
check('5: …with names only (the booker first, her own marked), never an email', JSON.stringify(arohaGame?.gamePlayers?.map((p) => [p.name, p.role, Boolean(p.you)])) === JSON.stringify([['Wiremu Tane', 'booker', false], ['Aroha Hura', 'opponent', true]]) && !/@/.test(JSON.stringify(arohaGame?.gamePlayers)), arohaGame?.gamePlayers);
check('5: her $10 is on what she can pay at the counter today', (arohaMine.dueNow || []).some((d) => d.title === `Game table at Warhammer night r11 ${today}` && d.due === 1000), arohaMine.dueNow);
check('5: she can\'t cancel it (only staff or the booker)', said(await proxy('POST', `bookings/${B1.id}/update`, { customer: AROHA, body: { status: 'cancelled' } })) === '403 Only staff can change that booking.');
await fake('POST', 'customer', { id: RAWIRI, tags: [], name: 'Rawiri Moana', email: INVITED });
const rawiri = (await proxy('GET', `me?name=${encodeURIComponent('Rawiri Moana')}`, { customer: RAWIRI })).data;
const rawiriGame = (rawiri.bookings || []).find((b) => b.id === B2.id);
check('5: the invited player makes an account with that email: the game is in his My Lair (Ngaio\'s game, his code)', rawiriGame && rawiriGame.playerOf?.name === 'Ngaio' && rawiriGame.ticketCode === rawiri.member?.code && rawiriGame.due === 1000, rawiriGame || rawiri.bookings);
const relisted = ((await me(NGAIO)).bookings || []).find((b) => b.id === B2.id);
check('5: …and Ngaio\'s list names him now', relisted?.gamePlayers?.[2]?.name === 'Rawiri Moana' && relisted.gamePlayers[2].member === true, relisted?.gamePlayers);

/* 6. check-in: the staff page and the POS */
const card = await proxy('POST', 'checkin', { customer: STAFF, body: { code: codes.aroha.toLowerCase() } });
const row = (card.data.rows || []).find((r) => r.playerOf);
check('6: Aroha\'s member code at the staff page: Wiremu\'s game (playerOf), her $10 on her total', card.status === 200 && card.data.kind === 'member' && row && row.id === B1.id && row.playerOf.name === 'Wiremu' && row.due === 1000 && card.data.due === 1000 && /Wiremu booked them into a game at /.test(card.data.message || ''), card.data.error || { due: card.data.due, row, message: card.data.message });
check('6: staff see the players with their codes', row?.gamePlayers?.[0]?.code === codes.aroha && row.gamePlayers[0].email === 'aroha.r11@example.com', row?.gamePlayers);
const scan = await pos('POST', 'scan', { code: codes.aroha });
const posRow = (scan.data.rows || []).find((r) => r.playerOf);
check('6: the POS: her row is her own share (her own row id), not the whole booking', scan.status === 200 && posRow && /^bp_/.test(posRow.id) && posRow.ref === B1.ref && posRow.due === 1000 && posRow.customerId === AROHA && posRow.split === false, scan.data.error || posRow);
const posIn = await pos('POST', 'checkin', { id: posRow?.id, type: 'booking' });
check('6: checking her row in checks the game in; the cart line is her $10, with the booking\'s code and her account', posIn.status === 200 && posIn.data.checkedIn === true && posIn.data.lines?.length === 1 && posIn.data.lines[0].price === '10.00' && posIn.data.lines[0].properties?._booking === B1.ref && posIn.data.lines[0].properties?._share === '1' && posIn.data.customer?.id === AROHA, posIn.data.error || posIn.data.lines);
const seated = (await bookings()).find((b) => b.id === B1.id);
check('6: the game is checked in', seated?.status === 'seated', seated?.status);
await fake('POST', 'order', { id: 9911001, customerId: AROHA, subtotal: 1000, source: 'pos' });
const paid = await webhook({ id: 9911001, source_name: 'pos', line_items: [{ id: 99110011, price: '10.00', quantity: 1, properties: [{ name: '_booking', value: B1.ref }, { name: '_share', value: '1' }] }] });
await wait(300);
const paidRow = (await bookings()).find((b) => b.id === B1.id);
check('6: paying her line pays her part only ($10 of $20)', paid.status === 200 && paidRow?.paidAmount === 1000 && paidRow.paid === false, { status: paid.status, paidAmount: paidRow?.paidAmount, paid: paidRow?.paid });
check('6: nothing more for her; Wiremu\'s own code still finds the $10 left', ((await pos('POST', 'scan', { code: codes.aroha })).data.rows || []).find((r) => r.playerOf)?.due === 0 && ((await pos('POST', 'scan', { code: codes.wiremu })).data.rows || []).find((r) => r.ref === B1.ref)?.due === 1000);

/* tidy up: the bookers cancel, staff remove the event (it's tonight's, and the run may go again) */
for (const [id, who] of [[B1.id, STAFF], [B2.id, NGAIO]]) if (id) await proxy('POST', `bookings/${id}/update`, { customer: who, body: { status: 'cancelled' } });
if (handle) await proxy('POST', `events/${handle}/delete`, { customer: STAFF, body: {} });

process.exit(summary() ? 1 : 0);

// Round 8, guests (contract v8, section 2), HTTP only (no browser), on the real Worker and the fake Admin API: friends on
// event sign-ups, each by member code or by name. Mo (6 Oct): "For signing up for events always ask if they intend to
// get another person and have it as a thing to add another and another etc.etc. with either their code and if they
// don't have one state their name etc."
//   1. the 422s: a person with neither, a code Gobgob doesn't know (as typed, in capitals), your own code, a member twice,
//      more than 6 people; nothing is saved
//   2. Ria signs up for tonight's D&D with Manu by his code (any case, no dashes) and Jo by name: 3 people, $45, the
//      names the Lair has; her email says "Coming: Ria Hohaia, Manu Tipene, Jo Bloggs"; Manu isn't emailed
//   3. staff see each guest with their account and code; Manu's My Lair lists it (guestOf, canCancel false, no money, his
//      code as the ticket); he can't cancel it (403), and neither can anyone else
//   4. Manu's member code at the staff page's check-in shows the sign-up he's on; checking it in gives him a stamp and
//      Ria 2 (her and Jo)
//   5. an older page (people, no guests) works as before, its email saying "a friend"
import { proxy, fake, check, summary } from './client.mjs';
import { key, addDays, nextDow } from './r6-time.mjs';

const STAFF = '7001';
const RIA = '7801'; // Ria Hohaia signs up
const MANU = '7802'; // Manu Tipene comes along by his code
const KAHU = '7803'; // Kahu Peters: a member who isn't on it
const today = key(Date.now());
const TONIGHT = `dnd-tonight@${today}`;
const LATER = `dnd-sunday-10am@${addDays(nextDow(0), 35)}`;
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
for (const [id, name] of [[RIA, 'Ria Hohaia'], [MANU, 'Manu Tipene'], [KAHU, 'Kahu Peters']]) {
  await fake('POST', 'customer', { id, tags: [], name, email: `${name.split(' ')[0].toLowerCase()}.r8@example.com` });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const stamps = async (id) => {
  const L = (await me(id)).loyalty || {};
  return (L.cards || 0) * 10 + (L.stamps || 0);
};
const codes = { ria: (await me(RIA)).member?.code, manu: (await me(MANU)).member?.code };
check('setup: Ria and Manu have member codes', Boolean(codes.ria && codes.manu), codes);
const join = (id, body, who = RIA) => proxy('POST', `events/${id}/join`, { customer: who, body: { name: 'Ria Hohaia', email: 'ria.r8@example.com', ...body } });
const floorJoins = async () => (await proxy('GET', `floor?from=${Date.now() - 3600000}&to=${Date.now() + 40 * 86400000}`, { customer: STAFF })).data.joins || [];
// a clean slate on these dates (an earlier run on the same day signed up already)
for (const who of [RIA]) {
  for (const j of (await me(who)).joins || []) if ([TONIGHT, LATER].includes(j.occurrenceId) && j.status !== 'cancelled') await proxy('POST', `events/joins/${j.id}/cancel`, { customer: who, body: {} });
}

/* 1. the messages */
const before = (await floorJoins()).filter((j) => j.occurrenceId === TONIGHT).length;
check('1: a person with neither a code nor a name: 422 with the words', said(await join(TONIGHT, { guests: [{ name: 'Jo Bloggs' }, { code: '', name: ' ' }] })) === '422 Add a name or a member code for each person coming, or take them off the list.');
check('1: a code Gobgob doesn\'t know: 422, the code as typed in capitals', said(await join(TONIGHT, { guests: [{ code: 'zz-nope-1', name: 'Zed' }] })) === "422 Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or put their name instead.");
check('1: her own code: 422', said(await join(TONIGHT, { guests: [{ code: codes.ria.toLowerCase() }] })) === "422 That's your own member code, friend. Add the people coming with you.");
check('1: a member twice (typed two ways): 422 with his name', said(await join(TONIGHT, { guests: [{ code: codes.manu }, { code: codes.manu.replace(/-/g, ' ').toLowerCase() }] })) === '422 Manu Tipene is on the list twice.');
check('1: more than 6 people: 422', said(await join(TONIGHT, { guests: Array.from({ length: 6 }, (_, i) => ({ name: `Friend ${i + 1}` })) })) === '422 Sign up between 1 and 6 people.');
check('1: nothing was saved', (await floorJoins()).filter((j) => j.occurrenceId === TONIGHT).length === before);

/* 2. Ria with Manu (by code) and Jo (by name) */
const emails0 = (await fake('GET', 'emails')).length;
const signed = await join(TONIGHT, { people: 1, guests: [{ code: codes.manu.toLowerCase().replace(/-/g, '') }, { name: '  Jo   Bloggs ' }] });
const J = signed.data.join || {};
check('2: signed up: 3 people (the body\'s people ignored), $45 at the counter', signed.status === 200 && J.people === 3 && J.amount === 4500 && J.status === 'confirmed' && J.payment === 'store', signed.data.error || J);
check('2: the answer lists who\'s coming: the Lair\'s name for Manu (a member), Jo by name; no codes or IDs', JSON.stringify(J.guests) === JSON.stringify([{ name: 'Manu Tipene', member: true }, { name: 'Jo Bloggs', member: false }]), J.guests);
await new Promise((r) => setTimeout(r, 400));
const sent = (await fake('GET', 'emails')).slice(emails0);
const toRia = sent.find((e) => [].concat(e.to).includes('ria.r8@example.com'));
check('2: Ria\'s confirmation says "Coming: Ria Hohaia, Manu Tipene, Jo Bloggs"', toRia && /Coming: +Ria Hohaia, Manu Tipene, Jo Bloggs\n/.test(toRia.text) && /People: +3\n/.test(toRia.text), toRia ? toRia.text.slice(0, 400) : sent.map((e) => e.to));
check('2: guests aren\'t emailed', !sent.some((e) => [].concat(e.to).includes('manu.r8@example.com')), sent.map((e) => e.to));

/* 3. what staff, Manu and anyone else see */
const staffView = (await floorJoins()).find((j) => j.id === J.id);
check('3: staff see each guest with their account and member code', staffView && JSON.stringify(staffView.guests) === JSON.stringify([{ name: 'Manu Tipene', member: true, customerId: MANU, code: codes.manu }, { name: 'Jo Bloggs', member: false, customerId: null, code: null }]), staffView?.guests);
check('3: the public floor has no sign-ups', (await proxy('GET', 'floor')).data.joins === undefined);
const manuJoin = ((await me(MANU)).joins || []).find((j) => j.id === J.id);
check('3: Manu\'s My Lair lists it: guestOf Ria, canCancel false, no money, his code as the ticket',
  manuJoin && manuJoin.guestOf?.name === 'Ria' && manuJoin.canCancel === false && manuJoin.amount === 0 && manuJoin.due === 0 && manuJoin.paidAmount === 0 && manuJoin.ticketCode === codes.manu && manuJoin.name === 'Manu Tipene' && manuJoin.people === 3,
  manuJoin);
check('3: …without the other guests\' names', manuJoin && !JSON.stringify(manuJoin).includes('Jo Bloggs') && Array.isArray(manuJoin.guests) && manuJoin.guests.length === 0, manuJoin?.guests);
check('3: Ria\'s My Lair has the guests on her own sign-up', JSON.stringify(((await me(RIA)).joins || []).find((j) => j.id === J.id)?.guests) === JSON.stringify(J.guests));
check('3: Manu can\'t cancel it (403, the words)', said(await proxy('POST', `events/joins/${J.id}/cancel`, { customer: MANU, body: {} })) === '403 Only the person who signed up can change this. Ask them, or the counter.');
check('3: nor can someone not on it (403)', said(await proxy('POST', `events/joins/${J.id}/cancel`, { customer: KAHU, body: {} })) === '403 Only staff can change that sign-up.');

/* 4. check-in by Manu's member code, and the stamps */
const manuBefore = await stamps(MANU);
const riaBefore = await stamps(RIA);
const card = await proxy('POST', 'checkin', { customer: STAFF, body: { code: codes.manu.toLowerCase() } });
const row = (card.data.rows || []).find((r) => r.id === J.id);
check('4: Manu\'s member code at check-in: the sign-up he\'s on (guestOf Ria), not on his total', card.status === 200 && card.data.kind === 'member' && row && row.guestOf?.name === 'Ria' && row.type === 'join' && card.data.due === 0, card.data.error || { due: card.data.due, row });
check('4: the card\'s words say who signed him up', /Ria signed them up for Dungeons & Dragons at /.test(card.data.message || ''), card.data.message);
check('4: the row lists who\'s coming, as staff see them', row && row.guests?.map((g) => g.name).join() === 'Manu Tipene,Jo Bloggs' && row.guests[0].code === codes.manu, row?.guests);
const checked = await proxy('POST', 'checkin', { customer: STAFF, body: { id: J.id, type: 'join' } });
check('4: checking it in checks in everyone on it', checked.status === 200 && checked.data.checkedIn === true && checked.data.join?.status === 'attended' && checked.data.join.guests?.length === 2, checked.data.error || checked.data.message);
check('4: Manu gets his own stamp; Ria gets hers and Jo\'s', (await stamps(MANU)) === manuBefore + 1 && (await stamps(RIA)) === riaBefore + 2, { manu: [manuBefore, await stamps(MANU)], ria: [riaBefore, await stamps(RIA)] });
check('4: Manu\'s card lists the event', ((await me(MANU)).loyalty?.recent || []).some((s) => s.title === 'Dungeons & Dragons' && s.people === 1));
const posCode = await proxy('POST', `bookings/${J.id}/update`, { customer: STAFF, body: { status: 'confirmed' } });
check('4: undoing the check-in takes the stamps back', posCode.status === 200 && (await stamps(MANU)) === manuBefore && (await stamps(RIA)) === riaBefore);
await proxy('POST', `bookings/${J.id}/update`, { customer: STAFF, body: { status: 'attended' } });

/* 5. an older page: people, no guests */
const emails1 = (await fake('GET', 'emails')).length;
const old = await join(LATER, { people: 2 });
check('5: an older page (people 2, no guests) works as before', old.status === 200 && old.data.join?.people === 2 && old.data.join.amount === 3000 && old.data.join.guests?.length === 0, old.data.error || old.data.join);
await new Promise((r) => setTimeout(r, 400));
const oldMail = (await fake('GET', 'emails')).slice(emails1).find((e) => [].concat(e.to).includes('ria.r8@example.com'));
check('5: its email says "Coming: Ria Hohaia, a friend"', oldMail && /Coming: +Ria Hohaia, a friend\n/.test(oldMail.text), oldMail ? oldMail.text.slice(0, 300) : 'no email');
if (old.data.join?.id) await proxy('POST', `events/joins/${old.data.join.id}/cancel`, { customer: RIA, body: {} });

process.exit(summary() ? 1 : 0);

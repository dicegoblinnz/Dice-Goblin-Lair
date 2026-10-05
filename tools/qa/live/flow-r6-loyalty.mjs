// Round 6 (a): the loyalty card. Aroha, a new member, gets her welcome roll. Four sessions she turns up to (two tables,
// a TTRPG seat and an event sign-up, 10 people in all), checked in by staff, fill her card: a roll. Undoing a check-in
// takes its stamps back. Her rolls pay the d20's face in store credit (storeCreditAccountCredit at the fake), or a
// pending prize for the counter when Shopify refuses. Staff give her rolls and set when she became a customer; the POS
// shows her card; birthdays suggest a roll a year. The spend dice answer 410.
import { proxy, pos, fake, check, summary } from './client.mjs';
import { key, addDays, at, nextDow, wholeYears, sleep } from './r6-time.mjs';

const AROHA = '7205';
const STAFF = '7001';
await fake('POST', 'customer', { id: AROHA, tags: [], name: 'Aroha Tipene', email: 'aroha.t@example.com', createdAt: '2019-03-10T02:00:00Z' });
const me = async () => (await proxy('GET', `me?name=${encodeURIComponent('Aroha Tipene')}`, { customer: AROHA })).data;
const today = key(Date.now());

/* 1. A new member: the welcome roll, once */
let m = await me();
check('a new member: an empty card and the welcome roll', m.loyalty?.stamps === 0 && m.loyalty.cardSize === 10 && m.loyalty.cards === 0 && m.loyalty.rolls.available === 1 && m.loyalty.rolls.earned.welcome === 1, m.loyalty);
check('rolls (the old field) mirrors the loyalty rolls', m.rolls?.available === 1 && m.rolls.toNext === null && m.rolls.per === null && m.rolls.bonus === 1, m.rolls);
m = await me();
check('the welcome roll is given once, however often she comes back', m.loyalty.rolls.earned.welcome === 1 && m.loyalty.rolls.available === 1, m.loyalty.rolls);
await proxy('POST', 'me/profile', { customer: AROHA, body: { name: 'Aroha Tipene', firstName: 'Aroha', email: 'aroha.t@example.com', birthday: addDays(today, 5).slice(5) } });

/* 2. Sessions she turns up to: 3 + 4 + 2 + 1 people */
const D = addDays(today, 9);
const SAT = nextDow(6, today, 2);
const t1 = await proxy('POST', 'bookings', { customer: AROHA, body: { kind: 'table', tables: ['T18'], start: at(D, 18), end: at(D, 20), people: 3, name: 'Aroha Tipene', email: 'aroha.t@example.com' } });
const t2 = await proxy('POST', 'bookings', { customer: AROHA, body: { kind: 'table', tables: ['T19'], start: at(D, 20), end: at(D, 22), people: 4, name: 'Aroha Tipene', email: 'aroha.t@example.com' } });
const listed = await proxy('POST', 'games', { customer: '7103', body: { title: 'Masks: A New Generation (r6)', system: 'Masks', gm: 'Ana', email: 'ana@example.com', blurb: 'Teen superheroes, big feelings.', seats: 4, tables: ['T20'], start: at(D, 18), end: at(D, 21), gmFee: 500 } });
const seat = await proxy('POST', 'bookings', { customer: AROHA, body: { kind: 'gm-seat', gameId: listed.data.game?.id, people: 2, name: 'Aroha Tipene', email: 'aroha.t@example.com', players: [{ name: 'Aroha Tipene', character: 'Ripple' }, { name: 'Nikau', character: '' }] } });
const join = await proxy('POST', `events/dnd-saturday-6pm@${SAT}/join`, { customer: AROHA, body: { name: 'Aroha Tipene', email: 'aroha.t@example.com', people: 1 } });
check('booked: two tables, a TTRPG seat and an event sign-up', [t1, t2, seat, join].every((x) => x.status === 200), [t1, t2, seat, join].map((x) => x.data.error || 'ok'));
m = await me();
check('booking earns nothing: only turning up does', m.loyalty.stamps === 0 && m.loyalty.cards === 0, m.loyalty.stamps);
const checkin = (code) => proxy('POST', 'checkin', { customer: STAFF, body: { code, force: true } });
const stamps = [];
for (const x of [t1.data.booking, t2.data.booking, seat.data.booking, join.data.join]) {
  const r = await checkin(x.ref);
  stamps.push(r.data.checkedIn ? (await me()).loyalty.stamps : `not checked in: ${r.data.message || r.data.error}`);
}
check('each check-in stamps her card, one stamp a person: 3, 7, 9, then the tenth fills it', JSON.stringify(stamps) === JSON.stringify([3, 7, 9, 0]), stamps);
m = await me();
check('a full card: one roll, plus the welcome roll', m.loyalty.cards === 1 && m.loyalty.rolls.earned.cards === 1 && m.loyalty.rolls.available === 2, m.loyalty);
check('recent sessions, newest first, titled as My Lair shows them', m.loyalty.recent.length === 4 && m.loyalty.recent[0].title === 'Table T19' && m.loyalty.recent[0].people === 4 && m.loyalty.recent[3].title === 'Dungeons & Dragons' && m.loyalty.recent.some((r) => r.title === 'Masks: A New Generation (r6)' && r.people === 2), m.loyalty.recent);

/* 3. Undoing a check-in takes its stamps back; checking in again brings them back */
await proxy('POST', `bookings/${t1.data.booking.id}/update`, { customer: STAFF, body: { status: 'confirmed' } });
m = await me();
check('the first table\'s check-in undone: 7 stamps, the card isn\'t full', m.loyalty.stamps === 7 && m.loyalty.cards === 0 && m.loyalty.rolls.available === 1, m.loyalty);
const again = await checkin(t1.data.booking.ref);
m = await me();
check('checked in again: a full card', again.data.checkedIn && !again.data.already && m.loyalty.cards === 1 && m.loyalty.rolls.available === 2, { checkedIn: again.data.checkedIn, cards: m.loyalty.cards });

/* 4. Rolls: the spend dice have retired; a loyalty roll pays its face */
const spend = await proxy('POST', 'roll', { customer: AROHA, body: { kind: 'spend' } });
check('the spend dice answer 410', spend.status === 410 && spend.data.error === 'The spend dice have retired. Fill your loyalty card: 10 sessions earn a roll.', spend.data);
const fun = await proxy('POST', 'roll', { customer: AROHA, body: {} });
check('no kind: the home page\'s fun roll, nothing else', fun.status === 200 && Object.keys(fun.data).join() === 'roll', fun.data);
const credits0 = (await fake('GET', 'state')).credits.length;
const said = (n) => (n === 20 ? 'Natural 20! $20 store credit is yours.' : n === 1 ? "A 1! $1 store credit, and Gobgob's still proud of it." : `You rolled ${[8, 11, 18].includes(n) ? 'an' : 'a'} ${n}: $${n} store credit is yours.`);
const won = await proxy('POST', 'roll', { customer: AROHA, body: { kind: 'loyalty' } });
const face = won.data.roll;
check('a loyalty roll: the face is the prize, added to her store credit', won.status === 200 && won.data.kind === 'loyalty' && won.data.prize?.kind === 'credit' && won.data.prize.amount === face * 100 && won.data.prize.status === 'added' && won.data.message === said(face), won.data);
const credits = (await fake('GET', 'state')).credits;
check('Shopify was asked for that credit once (storeCreditAccountCredit)', credits.length === credits0 + 1 && credits.at(-1).customerId === AROHA && credits.at(-1).amount === face * 100, credits.at(-1));
check('the roll\'s card: one roll left, one used, in the history', won.data.loyalty?.rolls.available === 1 && won.data.loyalty.rolls.used === 1 && won.data.loyalty.history?.[0]?.roll === face && won.data.loyalty.history[0].status === 'added', won.data.loyalty?.rolls);

/* 5. Shopify refuses: a pending prize for the counter, and the staff hear */
const emails0 = (await fake('GET', 'emails')).length;
await fake('POST', 'set', { failCredit: true });
const pending = await proxy('POST', 'roll', { customer: AROHA, body: { kind: 'loyalty' } });
await fake('POST', 'set', { failCredit: false });
check('Shopify down: the prize is pending, "show this screen"', pending.status === 200 && pending.data.prize?.status === 'pending' && pending.data.message === `${said(pending.data.roll)} Show this screen at the counter to claim it.`, pending.data);
await sleep(800);
const alert = (await fake('GET', 'emails')).slice(emails0).find((e) => [].concat(e.to).includes('staff@dicegoblin.test') && /Prize to give at the counter: Aroha Tipene/.test(e.subject));
check('the staff are emailed to give it at the counter', Boolean(alert), (await fake('GET', 'emails')).slice(emails0).map((e) => e.subject));
const none = await proxy('POST', 'roll', { customer: AROHA, body: { kind: 'loyalty' } });
check('no rolls left: 409 with the card\'s words', none.status === 409 && none.data.error === 'No rolls yet, friend. Fill your card: 10 sessions earn a roll.', none.data);
let staffView = ((await proxy('GET', `members?q=${AROHA}`, { customer: STAFF })).data || [])[0];
check('staff see the pending prize, and mark it done', staffView?.pendingPrizes?.some((p) => p.id === pending.data.prize?.id) && (await proxy('POST', `prizes/${pending.data.prize?.id}/done`, { customer: STAFF, body: {} })).data.prize?.status === 'done', staffView?.pendingPrizes);

/* 6. Staff give rolls, and set when she became a customer */
const notStaff = await proxy('POST', `members/${AROHA}/rolls`, { customer: AROHA, body: { count: 5 } });
check('only staff give rolls (403)', notStaff.status === 403, notStaff.data);
const tooMany = await proxy('POST', `members/${AROHA}/rolls`, { customer: STAFF, body: { count: 21 } });
check('1 to 20 at a time', tooMany.status === 422 && tooMany.data.error === 'Give between 1 and 20 rolls.', tooMany.data);
const given = await proxy('POST', `members/${AROHA}/rolls`, { customer: STAFF, body: { count: 2, note: 'Ran the swap meet' } });
check('staff give her 2 rolls: the member comes back as GET /members lists them', given.status === 200 && given.data.member?.customerId === AROHA && given.data.member.loyalty?.rollsAvailable === 2 && 'owed' in given.data.member, given.data.member?.loyalty);
const year = await proxy('POST', `members/${AROHA}/since`, { customer: STAFF, body: { since: '2019' } });
check('customer since "2019": 1 January 2019, and her years with us', year.status === 200 && year.data.member?.customerSince === '2019-01-01' && year.data.member.yearsWithUs === wholeYears('2019-01-01', today), year.data.member && [year.data.member.customerSince, year.data.member.yearsWithUs]);
const future = await proxy('POST', `members/${AROHA}/since`, { customer: STAFF, body: { since: addDays(today, 1) } });
check('a date that hasn\'t happened is refused', future.status === 422, future.data);
const cleared = await proxy('POST', `members/${AROHA}/since`, { customer: STAFF, body: { since: null } });
staffView = ((await proxy('GET', `members?q=${AROHA}`, { customer: STAFF })).data || [])[0];
check('cleared: years with us comes from when her Shopify account was made (10 March 2019)', cleared.data.member?.customerSince === null && staffView?.yearsWithUs === wholeYears('2019-03-10', today) && staffView.loyalty?.rollsAvailable === 2 && typeof staffView.spendFy === 'number', staffView && { since: staffView.customerSince, years: staffView.yearsWithUs, loyalty: staffView.loyalty, spendFy: staffView.spendFy });

/* 7. The counter sees her card; her birthday's suggestion is a roll a year */
const scan = await pos('POST', 'scan', { code: m.member.code });
check('POS member scan: her card (display only)', scan.status === 200 && scan.data.loyalty?.stamps === 0 && scan.data.loyalty.cardSize === 10 && scan.data.loyalty.rollsAvailable === 2, scan.data.loyalty);
const birthdays = (await proxy('GET', 'members/birthdays', { customer: STAFF })).data || [];
const hers = birthdays.find((b) => b.customerId === AROHA);
check('birthdays: a roll for every year she\'s been with us', hers && hers.suggested?.rolls === Math.max(1, wholeYears('2019-03-10', today)), hers?.suggested);

process.exit(summary() ? 1 : 0);

// Round 11, reminders (contract v11-reminders), HTTP only (no browser), on the real Worker and the fake Admin API (and
// its Resend stand-in): "Remind me the day before" on an event date's "I'm coming" or "Maybe", and the waitlist for a
// full date. Mo (9 Oct 2026): "have a add to calendar option on it and possibly a reminder the day prior if they opt for
// it?" and "if we went more let it notify us so we cns try to organize a new group to accommodate".
//   0. staff add three events with the events editor: a market's Saturday and Sunday (free entry), and a night with 2
//      places at $10, all nine days or more away (so the real clock's maintenance never reminds anyone in this run)
//   1. opting in: a guest's "I'm coming" with remind: true, a member's Maybe and then the one-tap toggle, a guest who
//      didn't ask, and the guest's Sunday too
//   2. the reminders at a fixed time (POST /__dev/reminders { at }, the dev entry's door to the Lair's internal route):
//      none at 8:55am the day before; at 10am exactly one each, with what, when, where, the price, Add to calendar and
//      how to take it back; never twice; Sunday's the day after; never at night, and that morning for one turned on late
//   3. Add to calendar: GET /ics/<id>.ics on the Worker (a calendar file), and a 404 for a date that isn't on
//   4. the waitlist: a full date, the staff's email (full, who, how many, the total, the moment to organise another
//      group, replies to the person) and the person's (nothing booked or paid); counts only for the public, names for
//      staff; a member on it; taking it back; room left means sign up instead
// Run inside the live lock: flock /tmp/lair-live.lock sh -c 'cd tools/qa/live && ./up.sh && node flow-r11-reminders.mjs; ./down.sh'
import { WORKER, proxy, fake, check, summary } from './client.mjs';
import { key, addDays, at, sleep } from './r6-time.mjs';

const STAFF = '7001';
const HINE = '7931'; // a member: Maybe, then the reminder; later on the waitlist
const today = key(Date.now());
const SAT = addDays(today, 9);
const SUN = addDays(SAT, 1);
const EVE = addDays(SAT, -1);
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const enc = (id) => encodeURIComponent(id).replace(/%40/g, '@');
const allEmails = async () => fake('GET', 'emails');
const emailsSince = async (from, to) => (await allEmails()).slice(from).filter((e) => !to || [].concat(e.to).includes(to));
const interest = (body, customer = '') => proxy('POST', 'interest', { customer, body });
const remind = (id, body, customer = '') => proxy('POST', `interest/${encodeURIComponent(id)}/remind`, { customer, body });
const takeBack = (id, body = {}, customer = '') => proxy('POST', `interest/${encodeURIComponent(id)}/remove`, { customer, body });
const floor = async (customer = '') => (await proxy('GET', `floor?from=${Date.now() - 3600000}&to=${Date.now() + 30 * 86400000}`, { customer })).data;
const remindersAt = async (ms) => {
  const res = await fetch(`${WORKER}/__dev/reminders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: ms }) });
  return res.json();
};
const longDay = (k) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(at(k, 12))).replace(/,/g, '');
const shortDay = (k) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at(k, 12))).replace(/,/g, '');
const isReminder = (e) => /^(Tomorrow|Today): Oddity Alley/.test(e.subject || '');

/* 0. the events */
const made = {};
for (const [handle, body] of [
  ['oddity-alley-saturday-r11', { title: 'Oddity Alley Saturday (r11)', type: 'market', start: at(SAT, 10), end: at(SAT, 16), entryFee: 0, payment: 'store', priceNote: 'Free entry', description: 'The in-store market.' }],
  ['oddity-alley-sunday-r11', { title: 'Oddity Alley Sunday (r11)', type: 'market', start: at(SUN, 10), end: at(SUN, 16), entryFee: 0, payment: 'store', description: 'The in-store market, day two.' }],
  ['blood-on-the-clocktower-r11', { title: 'Blood on the Clocktower (r11)', type: 'social', start: at(SUN, 12), end: at(SUN, 18), capacity: 2, entryFee: 10, payment: 'store', description: 'Social deduction for a crowd.' }],
]) {
  const res = await proxy('POST', 'events', { customer: STAFF, body });
  made[handle] = res.data.event || {};
  check(`0: staff add ${body.title}`, res.status === 200 && made[handle].handle === handle, res.data.error || made[handle].handle);
}
const SATURDAY = `oddity-alley-saturday-r11@${SAT}`;
const SUNDAY = `oddity-alley-sunday-r11@${SUN}`;
const CLOCK = `blood-on-the-clocktower-r11@${SUN}`;

/* 1. opting in */
const ruby = await interest({ kind: 'event', id: SATURDAY, coming: true, remind: true, name: 'Ruby Tane', email: 'ruby.r11@example.com', phone: '021 555 0211' });
const R = ruby.data.interest || {};
check('1: a guest\'s "I\'m coming" with "Remind me the day before": the answer says so, with her key', ruby.status === 200 && R.level === 'coming' && R.remind === true && R.reminded === false && Boolean(R.key), ruby.data);
await fake('POST', 'customer', { id: HINE, tags: [], name: 'Hine Example', email: 'hine.r11@example.com', verified: true });
await proxy('GET', `me?name=${encodeURIComponent('Hine Example')}`, { customer: HINE });
const hine = await interest({ kind: 'event', id: SATURDAY }, HINE);
const H = hine.data.interest || {};
check('1: a member\'s one-tap Maybe: no reminder until she asks', hine.status === 200 && H.level === 'maybe' && H.remind === false, hine.data);
const on = await remind(H.id, { remind: true }, HINE);
check('1: her toggle turns it on, and changes nothing else', on.status === 200 && on.data.interest?.remind === true && on.data.interest?.level === 'maybe', on.data);
check('1: nobody else can change it', said(await remind(H.id, { remind: false })) === "403 That isn't yours to change.");
const tama = await interest({ kind: 'event', id: SATURDAY, coming: true, name: 'Tama Rewiti', email: 'tama.r11@example.com', phone: '021 555 0212' });
check('1: a guest who didn\'t ask has no reminder', tama.status === 200 && tama.data.interest?.remind === false, tama.data);
const rubySun = await interest({ kind: 'event', id: SUNDAY, coming: true, remind: true, name: 'Ruby Tane', email: 'ruby.r11@example.com', phone: '021 555 0211' });
check('1: the market\'s Sunday is a date of its own: its own row and reminder', rubySun.status === 200 && rubySun.data.interest?.id !== R.id && rubySun.data.interest?.remind === true, rubySun.data);

/* 2. the reminders at a fixed time */
const before = (await allEmails()).length;
const early = await remindersAt(at(EVE, 8, 55));
check('2: 8:55am the day before: none yet', early.sent === 0, early);
const run = await remindersAt(at(EVE, 10, 0));
check('2: 10am the day before: two (Ruby and Hine), for Saturday only', run.sent === 2 && JSON.stringify(run.dates) === JSON.stringify([SATURDAY]) && run.ok === true, run);
await sleep(300);
const sent = (await emailsSince(before)).filter(isReminder);
const toRuby = sent.filter((e) => [].concat(e.to).includes('ruby.r11@example.com'));
const toHine = sent.filter((e) => [].concat(e.to).includes('hine.r11@example.com'));
check('2: exactly one reminder each in the fake Resend, and none for Tama', sent.length === 2 && toRuby.length === 1 && toHine.length === 1, sent.map((e) => [e.to, e.subject]));
const r = toRuby[0] || {};
check('2: Ruby\'s: "Tomorrow: Oddity Alley Saturday (r11), 10am"', r.subject === 'Tomorrow: Oddity Alley Saturday (r11), 10am', r.subject);
check('2: what and when', (r.text || '').includes(`Kia ora Ruby, here’s the reminder you asked for: Oddity Alley Saturday (r11) is tomorrow, ${longDay(SAT)}, 10am to 4pm.`), (r.text || '').slice(0, 400));
check('2: where: the address, upstairs above Whitcoulls, the lift (and its weekend hours on a Saturday)', /Where: +Dice Goblin, [^\n]+\n +Upstairs in Royal Oak Mall, above Whitcoulls\. The lift is next to Whitcoulls\. On weekends the lift runs during mall hours, 10am to 5pm\./.test(r.text || ''), (r.text || '').match(/Where:[\s\S]{0,260}/)?.[0]);
check('2: the price as the event says it: "Free entry"', /Entry: +Free entry/.test(r.text || ''));
check('2: Add to calendar (the calendar file on the Worker) and Google Calendar', (r.text || '').includes(`Add to calendar: http://127.0.0.1:8787/ics/${encodeURIComponent(SATURDAY)}.ics`) && /Google Calendar: https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&/.test(r.text || ''));
check('2: how to take it back: the event\'s page, with her key (she has no account)', (r.text || '').includes(`?interest=${R.id}&key=${R.key}&`) && /Not coming after all\? Take it back on the event’s page \(the link above\)/.test(r.text || ''));
const h = toHine[0] || {};
check('2: Hine\'s (a maybe): "Tomorrow’s the day", My Lair to take it back, no key in the link', /TOMORROW’S THE DAY/.test(h.text || '') && /You said maybe\. No pressure, friend: come along if you can\./.test(h.text || '') && /in My Lair/.test(h.text || '') && !/key=/.test(h.text || ''));
const again = await remindersAt(at(EVE, 10, 10));
await sleep(300);
check('2: the next run sends nothing more: never twice', again.sent === 0 && (await emailsSince(before)).filter(isReminder).length === 2, again);
const mine = (await proxy('GET', 'me', { customer: HINE })).data.interests?.find((i) => i.targetId === SATURDAY);
check('2: GET /me says her reminder went', mine?.remind === true && mine?.reminded === true, mine);
const sunday = await remindersAt(at(SAT, 9, 30));
await sleep(300);
const sunMail = (await emailsSince(before, 'ruby.r11@example.com')).filter(isReminder);
check('2: Saturday morning: Ruby\'s Sunday reminder, its own', sunday.sent === 1 && JSON.stringify(sunday.dates) === JSON.stringify([SUNDAY]) && sunMail.length === 2 && sunMail[1].subject === 'Tomorrow: Oddity Alley Sunday (r11), 10am', { sunday, subjects: sunMail.map((e) => e.subject) });
// Tama turns his on after the day before's runs: nothing at 10pm that night, and it comes that morning instead
await remind(tama.data.interest.id, { remind: true, key: tama.data.interest.key });
const night = await remindersAt(at(EVE, 22, 0));
check('2: 10pm the day before: nothing goes at night', night.sent === 0, night);
const morning = await remindersAt(at(SAT, 9, 5));
await sleep(300);
const tamaMail = (await emailsSince(before, 'tama.r11@example.com')).filter(isReminder);
check('2: 9:05am on the day: Tama\'s comes then, as "Today"', morning.sent === 1 && tamaMail.length === 1 && tamaMail[0].subject === 'Today: Oddity Alley Saturday (r11), 10am' && /is today, /.test(tamaMail[0].text || ''), { morning, subjects: tamaMail.map((e) => e.subject) });

/* 3. Add to calendar */
const ics = await fetch(`${WORKER}/ics/${encodeURIComponent(SATURDAY)}.ics`);
const icsText = (await ics.text()).replace(/\r\n /g, '');
check('3: GET /ics/<date>.ics is a calendar file for that date', ics.status === 200 && /^text\/calendar/.test(ics.headers.get('content-type') || '') && /attachment; filename="oddity-alley-saturday-r11-/.test(ics.headers.get('content-disposition') || '') && icsText.includes('SUMMARY:Oddity Alley Saturday (r11)') && icsText.includes(`UID:oddity-alley-saturday-r11-${SAT}@dicegoblin.nz`) && icsText.includes('DESCRIPTION:Free entry'), icsText.slice(0, 500));
const missing = await fetch(`${WORKER}/ics/${encodeURIComponent(`nope@${SAT}`)}.ics`);
check('3: a date that isn\'t on the calendar is a 404', missing.status === 404 && (await missing.text()) === 'That event date could not be found.');

/* 4. the waitlist */
check('4: room left: sign up instead', said(await interest({ waitlist: true, kind: 'event', id: CLOCK, people: 1, name: 'Ruby Tane', email: 'ruby.r11@example.com', phone: '021 555 0211' })) === '409 There’s still room for 2 people, so sign up instead.');
const kiri = await proxy('POST', `events/${enc(CLOCK)}/join`, { body: { name: 'Kiri Smith', email: 'kiri.r11@example.com', phone: '021 555 0213', people: 2 } });
check('4: Kiri signs up for 2: the date is full', kiri.status === 200 && kiri.data.spacesLeft === 0, kiri.data);
const mark = (await allEmails()).length;
const wait = await interest({ waitlist: true, kind: 'event', id: CLOCK, people: 2, note: 'We could start a second table.', name: 'Ruby Tane', email: 'ruby.r11@example.com', phone: '021 555 0211' });
const W = wait.data.interest || {};
check('4: Ruby joins the waitlist for 2: never a sign-up, emails to the staff and to her', wait.status === 200 && W.level === 'waitlist' && W.people === 2 && Boolean(W.key) && wait.data.emailed === true && wait.data.staffEmailed === true && wait.data.counts?.waiting === 2, wait.data);
await sleep(600);
const staffMail = (await emailsSince(mark, 'staff@dicegoblin.test'))[0] || {};
check('4: the staff\'s email: "Waitlist: Blood on the Clocktower (r11), <day> (2 waiting)", replies to Ruby', staffMail.subject === `Waitlist: Blood on the Clocktower (r11), ${shortDay(SUN)} (2 waiting)` && staffMail.reply_to === 'ruby.r11@example.com', { subject: staffMail.subject, reply_to: staffMail.reply_to });
check('4: plainly: full (2 of 2), who and how many, her mobile and note, the total, the moment to organise another group', [
  `Blood on the Clocktower (r11) on ${longDay(SUN)} is full (2 of 2 places). Ruby Tane just joined the waitlist for 2 people.`,
  '2 people are waiting now. This is the moment to organise another group, if you can.', '021 555 0211', 'We could start a second table.',
].every((x) => (staffMail.text || '').includes(x)), (staffMail.text || '').slice(0, 700));
const herMail = (await emailsSince(mark, 'ruby.r11@example.com'))[0] || {};
check('4: Ruby\'s email: on the waitlist, nothing booked or paid, the team will be in touch', herMail.subject === `You’re on the waitlist: Blood on the Clocktower (r11), ${shortDay(SUN)}` && (herMail.text || '').includes('Nothing is booked and nothing is paid. If a place opens up, or the team can start another group, they’ll be in touch.'), { subject: herMail.subject, text: (herMail.text || '').slice(0, 400) });
const pub = await floor();
check('4: the public floor: 2 waiting, 2 places taken, no names', pub.eventInterest?.[CLOCK]?.waiting === 2 && pub.eventJoins?.[CLOCK] === 2 && !JSON.stringify(pub).includes('ruby.r11@example.com'), { interest: pub.eventInterest?.[CLOCK], joins: pub.eventJoins?.[CLOCK] });
const hineWait = await interest({ waitlist: true, kind: 'event', id: CLOCK, phone: '021 555 0214' }, HINE);
check('4: Hine (logged in) joins for 1: her account fills in her name and email', hineWait.status === 200 && hineWait.data.interest?.name === 'Hine Example' && hineWait.data.interest?.people === 1 && hineWait.data.interest?.key === undefined, hineWait.data);
await sleep(600);
check('4: the staff hear again, with the new total', (await emailsSince(mark, 'staff@dicegoblin.test')).some((e) => e.subject === `Waitlist: Blood on the Clocktower (r11), ${shortDay(SUN)} (3 waiting)`));
const desk = ((await floor(STAFF)).interests || []).filter((i) => i.occurrenceId === CLOCK).map((i) => [i.name, i.level, i.people, i.email, i.phone, i.note]);
check('4: staff see names, people, emails, mobiles and notes', JSON.stringify(desk) === JSON.stringify([['Ruby Tane', 'waitlist', 2, 'ruby.r11@example.com', '021 555 0211', 'We could start a second table.'], ['Hine Example', 'waitlist', 1, 'hine.r11@example.com', '021 555 0214', '']]), desk);
const off = await takeBack(W.id, { key: W.key });
check('4: Ruby takes herself off with her key: 1 waiting', off.status === 200 && off.data.interest?.status === 'removed' && off.data.counts?.waiting === 1, off.data);
const kiriJoin = ((await floor(STAFF)).joins || []).find((j) => j.email === 'kiri.r11@example.com');
await proxy('POST', `events/joins/${kiriJoin?.id}/cancel`, { customer: STAFF, body: {} });
const afterCancel = await floor(STAFF);
check('4: a place freeing up books nobody by itself: Hine is still waiting, staff decide', (afterCancel.interests || []).some((i) => i.occurrenceId === CLOCK && i.level === 'waitlist' && i.name === 'Hine Example') && !afterCancel.eventJoins?.[CLOCK], { joins: afterCancel.eventJoins?.[CLOCK] });

process.exit(summary() ? 1 : 0);

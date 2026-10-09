// Round 9, play (contract v9-play), HTTP only (no browser), on the real Worker and the fake Admin API: "I'm interested"
// in a TTRPG session and "Maybe" (or "I'm coming", for an event with no sign-ups) for an event date. Mo (9 Oct): "have
// the option to click on games with spaces in them to say you are interested in joining or others can have an option to
// register interest and the gm will get back to you", and "events for card games etc. where you say you are coming or
// even planning on coming … so that we can get rough numbers".
//   1. Ana lists a session; a guest says they're interested: the answer (level, key, counts), the GM's email ("Ruby is
//      interested in <title> on <day>", her note, mobile and email, replies to her), and saying it again changes the
//      note without a second email
//   2. the floor: a count for everyone, never a name; the GM and staff see who
//   3. an event date: Maybe and I'm coming (no sign-ups), counts on the floor, names for staff only; "coming" on a date
//      with sign-ups is refused; a guest takes theirs back with its key, and a wrong key can't
//   4. a member says it logged in (their account fills the name and email); GET /me lists it; only they can take it back
//   5. adoption: interest left with an email joins the account when they log in with it (GET /me)
import { proxy, fake, check, summary } from './client.mjs';
import { key, addDays, at, nextDow, sleep } from './r6-time.mjs';

const STAFF = '7001';
const ANA = '7103';
const HINE = '7911'; // a member who says maybe logged in
const WIREMU = '7912'; // says he's interested as a guest, then makes an account with that email
const D = addDays(key(Date.now()), 12);
const today = key(Date.now());
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const emailsSince = async (from, to) => (await fake('GET', 'emails')).slice(from).filter((e) => !to || [].concat(e.to).includes(to));
const floor = async (customer = '') => (await proxy('GET', `floor?from=${Date.now() - 3600000}&to=${Date.now() + 40 * 86400000}`, { customer })).data;
const interest = (body, customer = '') => proxy('POST', 'interest', { customer, body });
const takeBack = (id, body = {}, customer = '') => proxy('POST', `interest/${encodeURIComponent(id)}/remove`, { customer, body });
const shortDay = (ms) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/,/g, '');

/* 1. Ana lists a session; a guest says she's interested */
const listed = await proxy('POST', 'games', { customer: ANA, body: { title: 'Curse of Strahd (r9)', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Mists and wolves.', seats: 4, tables: ['T18'], start: at(D, 18), end: at(D, 21), gmFee: 500 } });
const game = listed.data.game || {};
check('1: Ana lists a session (open straight away)', listed.status === 200 && game.status === 'open', listed.data.error);
check('1: a guest needs a mobile, as on a sign-up', said(await interest({ kind: 'session', id: game.id, name: 'Ruby Tane', email: 'ruby.r9@example.com' })) === '422 Add a mobile number so we can reach you on the day.');
check('1: the GM can\'t be interested in their own game', said(await interest({ kind: 'session', id: game.id }, ANA)) === "422 That's your own game, friend. Your players can say they're interested.");
const emails0 = (await fake('GET', 'emails')).length;
const ruby = await interest({ kind: 'session', id: game.id, name: 'Ruby Tane', email: 'ruby.r9@example.com', phone: '021 555 0191', note: 'First time playing D&D. Is that OK?' });
const R = ruby.data.interest || {};
check('1: interested: the answer has the level, a key for this browser, the count and that the GM was emailed', ruby.status === 200 && R.level === 'interested' && R.kind === 'session' && R.targetId === game.id && Boolean(R.key) && ruby.data.counts?.interested === 1 && ruby.data.emailed === true && ruby.data.already === false, ruby.data);
await sleep(800);
const toGm = (await emailsSince(emails0, 'ana@example.com'))[0];
check('1: the GM\'s email: "Ruby is interested in Curse of Strahd (r9) on <day>", replies to Ruby', toGm && toGm.subject === `Ruby is interested in Curse of Strahd (r9) on ${shortDay(at(D, 18))}` && toGm.reply_to === 'ruby.r9@example.com', toGm && { subject: toGm.subject, reply_to: toGm.reply_to });
check('1: with her note, email and mobile, the seats left, and that nothing is booked', toGm && ['First time playing D&D. Is that OK?', 'ruby.r9@example.com', '021 555 0191', 'Nothing is booked yet', 'Reply to this email to get back to them.'].every((x) => toGm.text.includes(x)) && /Seats left: +4 of 4/.test(toGm.text), toGm?.text?.slice(0, 600));
const again = await interest({ kind: 'session', id: game.id, name: 'Ruby Tane', email: 'Ruby.R9@example.com', phone: '021 555 0191', note: 'Bringing a friend too' });
await sleep(600);
check('1: saying it again changes the note, keeps one, and doesn\'t email the GM twice', again.data.already === true && again.data.interest?.id === R.id && again.data.interest?.note === 'Bringing a friend too' && (await emailsSince(emails0, 'ana@example.com')).length === 1, again.data);

/* 2. the floor */
const pub = await floor();
const pubGame = (pub.games || []).find((g) => g.id === game.id) || {};
check('2: the public floor: a count, never a name', pubGame.interested === 1 && pubGame.interest === undefined && !JSON.stringify(pub).includes('Ruby Tane'), pubGame);
const gmGame = ((await floor(ANA)).games || []).find((g) => g.id === game.id) || {};
check('2: the GM sees who: name, note and how to reach her', gmGame.interest?.length === 1 && gmGame.interest[0].name === 'Ruby Tane' && gmGame.interest[0].note === 'Bringing a friend too' && gmGame.interest[0].email === 'ruby.r9@example.com', gmGame.interest);
const staffGame = ((await floor(STAFF)).games || []).find((g) => g.id === game.id) || {};
check('2: staff see who too', staffGame.interest?.[0]?.name === 'Ruby Tane', staffGame.interest);

/* 3. an event date: Maybe and I'm coming */
const COMMANDER = `commander-night@${nextDow(3, today, 1)}`; // Wednesdays, no sign-ups
const TONIGHT = `dnd-tonight@${today}`; // takes sign-ups
const maybe = await interest({ kind: 'event', id: COMMANDER, name: 'Tui Example', email: 'tui.r9@example.com', phone: '021 555 0192' });
check('3: Maybe for Commander night', maybe.status === 200 && maybe.data.interest?.level === 'maybe' && typeof maybe.data.counts?.maybe === 'number', maybe.data);
const coming = await interest({ kind: 'event', id: COMMANDER, name: 'Mere Example', email: 'mere.r9@example.com', phone: '021 555 0193', coming: true });
check('3: I\'m coming for a date with no sign-ups', coming.status === 200 && coming.data.interest?.level === 'coming', coming.data);
check('3: "coming" on a date that takes sign-ups is refused (the sign-up is the way)', said(await interest({ kind: 'event', id: TONIGHT, name: 'Mere Example', email: 'mere.r9@example.com', phone: '021 555 0193', coming: true })) === '422 This one takes sign-ups, so sign up to keep your place.');
const counts = (await floor()).eventInterest?.[COMMANDER];
check('3: the floor counts them, for everyone', counts && counts.maybe >= 1 && counts.coming >= 1, counts);
const pubFloor = JSON.stringify(await floor());
check('3: no names on the public floor', !/Tui Example|Mere Example/.test(pubFloor));
const staffNames = ((await floor(STAFF)).interests || []).filter((r) => r.occurrenceId === COMMANDER).map((r) => `${r.name}:${r.level}`).sort();
check('3: staff see the names (for Today\'s sign-ups)', staffNames.includes('Mere Example:coming') && staffNames.includes('Tui Example:maybe'), staffNames);
check('3: a wrong key can\'t take it back', said(await takeBack(maybe.data.interest.id, { key: 'not-the-key' })) === "403 That isn't yours to take back.");
const back = await takeBack(maybe.data.interest.id, { key: maybe.data.interest.key });
check('3: the guest takes hers back with the key her browser kept', back.status === 200 && back.data.interest?.status === 'removed', back.data);

/* 4. a member, logged in */
await fake('POST', 'customer', { id: HINE, tags: [], name: 'Hine Example', email: 'hine.r9play@example.com', verified: true });
await proxy('GET', `me?name=${encodeURIComponent('Hine Example')}`, { customer: HINE });
const hine = await interest({ kind: 'event', id: COMMANDER }, HINE);
check('4: logged in, her account fills in her name and email (no mobile needed)', hine.status === 200 && hine.data.interest?.name === 'Hine Example' && hine.data.interest?.key === undefined, hine.data);
const mine = (await proxy('GET', 'me', { customer: HINE })).data.interests || [];
check('4: GET /me lists it', mine.some((i) => i.targetId === COMMANDER && i.level === 'maybe' && i.kind === 'event'), mine);
check('4: someone else can\'t take it back', said(await takeBack(hine.data.interest.id, {}, ANA)) === "403 That isn't yours to take back.");
check('4: she can', (await takeBack(hine.data.interest.id, {}, HINE)).data.interest?.status === 'removed');

/* 5. adoption */
const guest = await interest({ kind: 'session', id: game.id, name: 'Wiremu Example', email: 'Wiremu.R9play@example.com', phone: '021 555 0194', note: 'Keen!' });
check('5: a guest says he\'s interested', guest.status === 200, guest.data);
await fake('POST', 'customer', { id: WIREMU, tags: [], name: 'Wiremu Example', email: 'wiremu.r9play@example.com', verified: true });
const his = (await proxy('GET', `me?name=${encodeURIComponent('Wiremu Example')}`, { customer: WIREMU })).data.interests || [];
check('5: when he makes an account with that email, it\'s his (GET /me)', his.some((i) => i.targetId === game.id && i.note === 'Keen!'), his);
const gmNow = ((await floor(ANA)).games || []).find((g) => g.id === game.id) || {};
check('5: the GM sees he\'s a member now', gmNow.interest?.find((p) => p.name === 'Wiremu Example')?.member === true, gmNow.interest);

summary();

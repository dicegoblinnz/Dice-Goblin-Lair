// Round 9, team (contract v9-team), HTTP only (no browser), on the real Worker and the fake Admin API: helpers and
// permissions, a member's store credit and emails, and adding people by member code or email. Mo (9 Oct): "give a
// member the staff option and they will gain access to what ever I allow but mainly about checking people in and
// booking tables out … With all the other bells and whistles left to me."
//   1. GET /staff/me: the main account (everything, team too), a customer (not staff), nobody logged in (401)
//   2. the main account makes Hana a helper by her member code: Check-in and Tables to start; she's staff at once, with
//      the floor's staff view and check-in, and nothing else (Members, the Team tab, changing her own: the 403's words)
//   3. ticked Members and Money: in straight away
//   4. store credit for Wiremu: added (no email from Shopify), a repeat that moves nothing, taken off with a note, more
//      than he has refused plainly, Shopify's balance not readable (the words), Shopify's own refusal; the history
//   5. Email them: from the shop's address, reply-to the shop, the message as written, signed "Mo, Dice Goblin", logged
//   6. event sign-ups added by staff: Wiremu by his member code, and someone by email (invited, with the account line)
//   7. added three times under one email (an event, a TTRPG seat, a weekly seat), signs up once: all three join
//   8. Hana removed: a customer again at once; the main account can't be removed
import { proxy, fake, check, summary } from './client.mjs';
import { key, addDays, nextDow, at } from './r6-time.mjs';

const OWNER = '7001'; // Mo Ashgrove, tagged staff
const HANA = '7901'; // Hana Kerei, made a helper
const WIREMU = '7902'; // Wiremu Pou, a member
const NEWBIE = '7903'; // Ari Newbie, invited by email, makes an account at the end
const NEW_EMAIL = 'ari.newbie.r9@example.com';
const today = key(Date.now());
const SATURDAY = `dnd-saturday-6pm@${nextDow(6, today, 15)}`;
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const NOT_YOURS = "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";
const settle = () => new Promise((r) => setTimeout(r, 500));
for (const [id, name] of [[HANA, 'Hana Kerei'], [WIREMU, 'Wiremu Pou']]) {
  await fake('POST', 'customer', { id, tags: [], name, email: `${name.split(' ')[0].toLowerCase()}.r9@example.com` });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
await proxy('GET', `me?name=${encodeURIComponent('Mo Ashgrove')}`, { customer: OWNER });
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const codes = { hana: (await me(HANA)).member?.code, wiremu: (await me(WIREMU)).member?.code };
check('setup: Hana and Wiremu have member codes', Boolean(codes.hana && codes.wiremu), codes);
// a clean slate: an earlier run on the same state made Hana a helper and signed Wiremu up
await proxy('POST', `team/${HANA}/remove`, { customer: OWNER, body: {} });
for (const j of (await me(WIREMU)).joins || []) if (j.occurrenceId === SATURDAY && j.status !== 'cancelled') await proxy('POST', `events/joins/${j.id}/cancel`, { customer: OWNER, body: {} });

/* 1. who's using the staff page */
const owner = (await proxy('GET', 'staff/me', { customer: OWNER })).data;
check('1: the main account: staff, owner, every permission and team', owner.staff === true && owner.role === 'owner' && ['checkin', 'tables', 'sessions', 'events', 'members', 'money', 'library', 'community', 'team'].every((p) => owner.perms.includes(p)), owner);
check('1: a customer: not staff', JSON.stringify((await proxy('GET', 'staff/me', { customer: HANA })).data) === JSON.stringify({ staff: false }));
check('1: nobody logged in: 401', said(await proxy('GET', 'staff/me')) === '401 Log in to use the staff page.');

/* 2. Hana made a helper by her member code */
const made = await proxy('POST', 'team', { customer: OWNER, body: { code: codes.hana.toLowerCase().replace(/-/g, ' ') } });
check('2: made a helper by her member code (any case, no dashes): Check-in and Tables', made.status === 200 && JSON.stringify(made.data.helper?.perms) === JSON.stringify(['checkin', 'tables']) && made.data.helper?.customerId === HANA, made.data);
const hana = (await proxy('GET', 'staff/me', { customer: HANA })).data;
check('2: Hana is staff at once: a helper with Check-in and Tables', hana.staff === true && hana.role === 'helper' && JSON.stringify(hana.perms) === JSON.stringify(['checkin', 'tables']) && hana.name === 'Hana', hana);
const floor = (await proxy('GET', `floor?from=${Date.now() - 3600000}&to=${Date.now() + 30 * 86400000}`, { customer: HANA })).data;
check('2: she sees the floor as staff (sign-ups and names)', floor.staff === true && Array.isArray(floor.joins), { staff: floor.staff, joins: Array.isArray(floor.joins) });
const card = await proxy('POST', 'checkin', { customer: HANA, body: { code: codes.wiremu } });
check('2: she can check in (a member code at the desk)', card.status === 200 && card.data.kind === 'member', said(card));
check('2: Members isn\'t hers: the words', said(await proxy('GET', 'members?q=wiremu', { customer: HANA })) === NOT_YOURS);
check('2: nor is the Team tab', said(await proxy('GET', 'team', { customer: HANA })) === NOT_YOURS);
check('2: she can\'t tick more for herself', said(await proxy('POST', `team/${HANA}`, { customer: HANA, body: { perms: ['money'] } })) === NOT_YOURS);
check('2: store credit isn\'t hers', said(await proxy('POST', `members/${WIREMU}/credit`, { customer: HANA, body: { amount: 500, note: 'x' } })) === NOT_YOURS);
const team = (await proxy('GET', 'team', { customer: OWNER })).data;
check('2: the team: the main account first, Hana with her permissions, and the log', team.owners?.[0]?.customerId === OWNER && team.helpers?.some((h) => h.customerId === HANA && h.madeBy?.customerId === OWNER) && team.log?.[0]?.action === 'added', { owners: team.owners, log: team.log?.slice(0, 2) });

/* 3. ticked Members and Money */
const ticked = await proxy('POST', `team/${HANA}`, { customer: OWNER, body: { perms: ['checkin', 'tables', 'members', 'money'] } });
check('3: Members and Money ticked', JSON.stringify(ticked.data.helper?.perms) === JSON.stringify(['checkin', 'tables', 'members', 'money']), ticked.data);
check('3: Members works for her straight away', (await proxy('GET', 'members?q=wiremu', { customer: HANA })).status === 200);

/* 4. store credit */
await fake('POST', 'set', { denyCreditRead: false, failCredit: false });
const start = (await proxy('GET', `members/${WIREMU}/credit`, { customer: HANA })).data;
check('4: his balance and an empty history', start.balance != null && start.problem === null && Array.isArray(start.history), start);
const b0 = start.balance;
const runKey = `r9-${Date.now()}`;
const added = await proxy('POST', `members/${WIREMU}/credit`, { customer: OWNER, body: { amount: 2000, note: 'Paid up front', key: `${runKey}-a` } });
check('4: $20 added: the balance after, from Shopify', added.status === 200 && added.data.balance === b0 + 2000 && added.data.change?.status === 'done', added.data);
const shop = await fake('GET', 'state');
const last = (shop.credits || []).filter((c) => c.customerId === WIREMU).slice(-1)[0];
check('4: Shopify isn\'t asked to email him', last && last.amount === 2000 && last.notify === false, last);
const again = await proxy('POST', `members/${WIREMU}/credit`, { customer: OWNER, body: { amount: 2000, note: 'Paid up front', key: `${runKey}-a` } });
check('4: the same request again moves nothing (repeated)', again.data.repeated === true && (await fake('GET', 'state')).creditBalances[WIREMU] === b0 + 2000, again.data);
check('4: taking off needs a note', said(await proxy('POST', `members/${WIREMU}/credit`, { customer: HANA, body: { amount: -500 } })) === '422 Add a note to say why the credit is coming off.');
const off = await proxy('POST', `members/${WIREMU}/credit`, { customer: HANA, body: { amount: -500, note: 'Took a $5 game home', key: `${runKey}-b` } });
check('4: Hana (Money) takes $5 off', off.status === 200 && off.data.balance === b0 + 1500, off.data);
const tooMuch = await proxy('POST', `members/${WIREMU}/credit`, { customer: HANA, body: { amount: -(b0 + 1600), note: 'Too much' } });
const dollars = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;
check('4: more than he has: refused plainly, nothing moves', said(tooMuch) === `409 Wiremu has ${dollars(b0 + 1500)} of store credit, so you can take off ${dollars(b0 + 1500)} at most.`, said(tooMuch));
await fake('POST', 'set', { denyCreditRead: true });
const blind = (await proxy('GET', `members/${WIREMU}/credit`, { customer: HANA })).data;
check('4: Shopify won\'t show balances yet: the words', blind.balance === null && blind.problem === "Shopify hasn't let the Lair read store credit balances yet. Approve the app's new permission in Shopify admin (Apps › Dice Goblin Lair).", blind);
const refused = await proxy('POST', `members/${WIREMU}/credit`, { customer: HANA, body: { amount: -(b0 + 9900), note: 'Way too much', key: `${runKey}-c` } });
check('4: Shopify refuses a take-off it can\'t cover: plain words, logged as failed', said(refused) === "409 Wiremu doesn't have that much store credit, so nothing came off. Check their balance and take off less.", said(refused));
await fake('POST', 'set', { denyCreditRead: false });
const history = (await proxy('GET', `members/${WIREMU}/credit`, { customer: OWNER })).data.history || [];
check('4: the history, newest first: failed, -$5, +$20', JSON.stringify(history.slice(0, 3).map((h) => [h.amount, h.status])) === JSON.stringify([[-(b0 + 9900), 'failed'], [-500, 'done'], [2000, 'done']]), history.slice(0, 3));

/* 5. Email them */
const emails0 = (await fake('GET', 'emails')).length;
const sent = await proxy('POST', `members/${WIREMU}/email`, { customer: OWNER, body: { subject: 'Your pre-order is in', message: 'Kia ora Wiremu,\n\nYour pre-order came in today.\nIt is behind the counter.' } });
check('5: sent, with fewer than 30 left today', sent.status === 200 && sent.data.email?.status === 'sent' && Number.isInteger(sent.data.left) && sent.data.left < 30, sent.data);
await settle();
const mail = (await fake('GET', 'emails')).slice(emails0).find((e) => [].concat(e.to).includes('wiremu.r9@example.com'));
check('5: from the shop\'s address to Wiremu, reply-to the shop', mail && mail.subject === 'Your pre-order is in' && mail.reply_to === 'staff@dicegoblin.test', mail ? { subject: mail.subject, reply_to: mail.reply_to } : 'no email');
check('5: the message as written, signed "Mo, Dice Goblin"', mail && /Kia ora Wiremu,\n\nYour pre-order came in today\.\nIt is behind the counter\./.test(mail.text) && /Mo, Dice Goblin/.test(mail.text), mail ? mail.text.slice(0, 300) : '');
const log = (await proxy('GET', `members/${WIREMU}/emails`, { customer: HANA })).data;
check('5: logged on his page (Hana with Members can see it)', log.emails?.[0]?.subject === 'Your pre-order is in' && log.emails[0].by?.customerId === OWNER && log.to === 'wiremu.r9@example.com', log.emails?.[0]);

/* 6. event sign-ups added by staff */
const emails1 = (await fake('GET', 'emails')).length;
const byCode = await proxy('POST', `events/${SATURDAY}/joins`, { customer: OWNER, body: { code: codes.wiremu.toLowerCase(), people: 2, note: 'With his brother' } });
check('6: Wiremu by his member code: 2 people, $30 at the counter, his account', byCode.status === 200 && byCode.data.join?.customerId === WIREMU && byCode.data.join?.amount === 3000 && byCode.data.join?.payment === 'store' && byCode.data.invited === false, said(byCode) || byCode.data.join);
check('6: twice: the words', said(await proxy('POST', `events/${SATURDAY}/joins`, { customer: OWNER, body: { code: codes.wiremu } })) === `409 Wiremu Pou is already on the list for this one (${byCode.data.join?.ref}).`);
check('6: Hana (no Events) can\'t', said(await proxy('POST', `events/${SATURDAY}/joins`, { customer: HANA, body: { code: codes.wiremu } })) === NOT_YOURS);
const byEmail = await proxy('POST', `events/${SATURDAY}/joins`, { customer: OWNER, body: { name: 'Ari Newbie', email: NEW_EMAIL } });
check('6: someone by name and email: invited, on the list under that email', byEmail.status === 200 && byEmail.data.invited === true && byEmail.data.join?.customerId === null, said(byEmail));
await settle();
const evMails = (await fake('GET', 'emails')).slice(emails1);
const toWiremu = evMails.find((e) => [].concat(e.to).includes('wiremu.r9@example.com'));
const toNewbie = evMails.find((e) => [].concat(e.to).includes(NEW_EMAIL));
check('6: Wiremu gets the usual "You\'re in" email', toWiremu && /^You're in: Dungeons & Dragons/.test(toWiremu.subject) && !/Make your Dice Goblin account/.test(toWiremu.text), toWiremu ? toWiremu.subject : evMails.map((e) => e.to));
check('6: the invitee\'s says how their account picks it up', toNewbie && new RegExp(`Make your Dice Goblin account with this email \\(${NEW_EMAIL.replace(/\./g, '\\.')}\\)`).test(toNewbie.text), toNewbie ? toNewbie.text.slice(0, 400) : 'no email');
const staffJoins = (await proxy('GET', `floor?from=${Date.now()}&to=${Date.now() + 40 * 86400000}`, { customer: OWNER })).data.joins || [];
check('6: both on the floor\'s sign-ups for staff', [byCode.data.join?.id, byEmail.data.join?.id].every((id) => staffJoins.some((j) => j.id === id)));

/* 7. three times under one email, one sign-up */
// a rerun on the same state finds its tables taken by the last run's games: try the next free week and table
const makeGame = async (body, dow, tables) => {
  let res;
  for (const table of tables) {
    for (let w = 0; w < 4; w += 1) {
      const day = nextDow(dow, today, 16 + 7 * w);
      res = await proxy('POST', 'games', { customer: OWNER, body: { ...body, tables: [table], start: at(day, 18), end: at(day, 21) } });
      if (res.status !== 409) return res;
    }
  }
  return res;
};
const oneOff = await makeGame({ title: 'Round 9 one-shot', system: 'Mothership', gm: 'Mo', blurb: 'Space horror for three.', seats: 3, schedule: 'one-shot', gmFee: 500 }, 3, ['P3', 'P2']);
const weekly = await makeGame({ title: 'Round 9 weekly', system: 'Pathfinder', gm: 'Mo', blurb: 'A weekly campaign.', seats: 3, schedule: 'weekly', gmFee: 500 }, 4, ['P4', 'G1', 'G2', 'G3', 'G4']);
check('7: two staff games to add Ari to', oneOff.status === 200 && weekly.status === 200, [said(oneOff), said(weekly)]);
const seat = await proxy('POST', `games/${oneOff.data.game?.id}/players`, { customer: OWNER, body: { name: 'Ari Newbie', email: NEW_EMAIL } });
const regular = await proxy('POST', `games/${weekly.data.game?.id}/players`, { customer: OWNER, body: { name: 'Ari Newbie', email: NEW_EMAIL, weekly: true } });
check('7: a seat at the one-shot, and a weekly seat with an invite', seat.status === 200 && regular.status === 200 && Boolean(regular.data.invite), [said(seat), said(regular)]);
await fake('POST', 'customer', { id: NEWBIE, tags: [], name: 'Ari Newbie', email: NEW_EMAIL, verified: true });
const ari = (await proxy('GET', `me?name=${encodeURIComponent('Ari Newbie')}`, { customer: NEWBIE })).data;
check('7: Ari signs up once: the event sign-up is theirs', (ari.joins || []).some((j) => j.id === byEmail.data.join?.id), (ari.joins || []).map((j) => j.title));
check('7: …and both game seats', ['Round 9 one-shot', 'Round 9 weekly'].every((t) => (ari.seats || []).some((s) => s.gameTitle === t)), (ari.seats || []).map((s) => s.gameTitle));
check('7: …and they\'re a regular at the weekly game', (ari.series || []).some((s) => s.title === 'Round 9 weekly'), ari.series);

/* 8. removed */
check('8: the main account can\'t be removed', said(await proxy('POST', `team/${OWNER}/remove`, { customer: OWNER, body: {} })) === "409 That's you, the main account. It can't be removed here.");
const gone = await proxy('POST', `team/${HANA}/remove`, { customer: OWNER, body: {} });
check('8: Hana removed', gone.status === 200 && gone.data.ok === true, gone.data);
check('8: she\'s a customer again at once', JSON.stringify((await proxy('GET', 'staff/me', { customer: HANA })).data) === JSON.stringify({ staff: false }) && said(await proxy('POST', 'checkin', { customer: HANA, body: { code: codes.wiremu } })) === '403 Staff only. Log in with your staff account.');
check('8: her floor is the public one', (await proxy('GET', 'floor', { customer: HANA })).data.joins === undefined);
// tidy up what this flow added on the Saturday, so a rerun starts clean
for (const id of [byCode.data.join?.id, byEmail.data.join?.id].filter(Boolean)) await proxy('POST', `events/joins/${id}/cancel`, { customer: OWNER, body: {} });

process.exit(summary() ? 1 : 0);

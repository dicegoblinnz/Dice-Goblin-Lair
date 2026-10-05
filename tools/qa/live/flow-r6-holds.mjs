// Round 6 (d), part 1: library holds. Hana (Stash: 3 games) reserves Wingspan's only copy: held until 12pm on the third
// day, and the staff and Hana are emailed. Wiremu (library-member: 1 game) sees it reserved and when it's back; Mere
// (no plan) can't reserve. Copies come from the variant's inventory (the fake's VariantCopies), or the page's copies
// for a game Shopify doesn't track, and the page's copies when Shopify refuses (scopes not approved). Staff reserve for
// a member with no plan, mark one collected, release one and hold it again. Hana also reserves Azul, which
// r6-travel.py runs out of time while wrangler is stopped; flow-r6-holds-expiry.mjs checks it went back on the shelf.
import fs from 'node:fs';
import { proxy, fake, check, summary } from './client.mjs';
import { holdUntil, longWhen, pageWhen, shortWhen, sleep } from './r6-time.mjs';

const HANA = '7211';
const WIREMU = '7212';
const MERE = '7213';
const STAFF = '7001';
const run = Date.now() % 100000;
const V = (n) => String(46000000 + (run % 1000) * 10 + n);
await fake('POST', 'customer', { id: HANA, tags: ['Simplee: Stash'], name: 'Hana Kereama', email: 'hana.k@example.com' });
await fake('POST', 'customer', { id: WIREMU, tags: ['library-member'], name: 'Wiremu Pohatu', email: 'wiremu.p@example.com' });
await fake('POST', 'customer', { id: MERE, tags: [], name: 'Mere Tawhiri', email: 'mere.t@example.com' });
for (const [id, name, email] of [[HANA, 'Hana Kereama', 'hana.k@example.com'], [WIREMU, 'Wiremu Pohatu', 'wiremu.p@example.com'], [MERE, 'Mere Tawhiri', 'mere.t@example.com']]) {
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
  await proxy('POST', 'me/profile', { customer: id, body: { name, firstName: name.split(' ')[0], email } });
}
await fake('POST', 'variant', { id: V(1), quantity: 1, tracked: true }); // Wingspan: one copy
await fake('POST', 'variant', { id: V(2), quantity: 7, tracked: false }); // Azul: not tracked, so the page's copies count
const game = (n, title, extra = {}) => ({ variantId: V(n), productId: String(91000 + n), title, shelfCode: 'DGL34', handle: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`, ...extra });
const reserve = (who, body) => proxy('POST', 'library/holds', { customer: who, body });
const status = async (ids, who = '') => (await proxy('GET', `library/status?ids=${ids.join(',')}`, { customer: who })).data.games || {};
const calls = async () => (await fake('GET', 'calls')).filter((c) => c.op === 'VariantCopies').length;

/* 1. Who can reserve */
check('logged out: 401', (await reserve('', game(1, 'Wingspan (Library)'))).status === 401);
const noPlan = await reserve(MERE, game(1, 'Wingspan (Library)'));
check('no library plan: 403 with the words', noPlan.status === 403 && noPlan.data.error === 'Join the library to reserve games, friend.', noPlan.data);

/* 2. Hana reserves Wingspan's only copy */
const emails0 = (await fake('GET', 'emails')).length;
const made = Date.now();
const hana = await reserve(HANA, game(1, 'Wingspan (Library)'));
const hold = hana.data.hold || {};
const until = holdUntil(made);
check('Hana reserves it: held until midnight on the third day, today counting as the first (round 7)', hana.status === 200 && hold.status === 'held' && hold.until === until && hold.variantId === V(1) && hold.shelfCode === 'DGL34', hana.data);
await sleep(800);
const mails = (await fake('GET', 'emails')).slice(emails0);
const staffMail = mails.find((e) => [].concat(e.to).includes('staff@dicegoblin.test'));
const hanaMail = mails.find((e) => [].concat(e.to).includes('hana.k@example.com'));
check('the staff are emailed: hold this game, for whom, until when', staffMail?.subject === `Hold this game: Wingspan (Library) (DGL34) for Hana Kereama, until ${longWhen(until)}` && /hana\.k@example\.com/.test(staffMail.text), staffMail?.subject);
check('Hana is emailed: on hold until then, collect it with her member code', hanaMail && hanaMail.text.includes(`Wingspan (Library) is on hold for you until ${longWhen(until)}. Collect it at the counter with your member code.`), hanaMail?.text?.slice(0, 300));
const twice = await reserve(HANA, game(1, 'Wingspan (Library)'));
check('reserving it again: "You\'ve already reserved this one"', twice.status === 409 && twice.data.error === `You've already reserved this one, friend. It's held until ${pageWhen(until)}.`, twice.data);

/* 3. Wiremu sees it reserved, and when it's back */
const seen = (await status([V(1)], WIREMU))[V(1)];
check('status for anyone else: one copy (from Shopify), held, nextFree its until, not theirs', seen && seen.copies === 1 && seen.held === 1 && seen.available === 0 && seen.nextFree === until && seen.mine === null, seen);
check('status for Hana: it\'s hers', (await status([V(1)], HANA))[V(1)]?.mine?.id === hold.id);
const full = await reserve(WIREMU, game(1, 'Wingspan (Library)'));
check('Wiremu tries: every copy is reserved, back on the shelf by …', full.status === 409 && full.data.error === `Every copy is reserved or out on loan right now. It's back on the shelf by ${shortWhen(until)} if nobody collects it.`, full.data);

/* 4. Copies the page sends for a game Shopify doesn't track; plan limits */
const azulW = await reserve(WIREMU, game(2, 'Azul (Library)', { copies: 2 }));
check('Azul isn\'t tracked in Shopify: the page\'s 2 copies count, and Wiremu reserves one', azulW.status === 200 && (await status([V(2)]))[V(2)]?.copies === 2, azulW.data.error || (await status([V(2)]))[V(2)]);
const limit = await reserve(WIREMU, game(3, 'Cascadia (Library)'));
check('Wiremu\'s plan is 1 game at a time', limit.status === 409 && limit.data.error === "Your plan has 1 game at a time, and you've got 1: 1 reserved. Return one or cancel a hold first.", limit.data);
const azulH = await reserve(HANA, game(2, 'Azul (Library)', { copies: 2 }));
check('Hana reserves Azul\'s other copy (the one that runs out of time)', azulH.status === 200, azulH.data.error);

/* 5. Shopify refuses (scopes not approved yet): the page's copies, and Shopify isn't asked again for 10 minutes */
await fake('POST', 'set', { failVariant: true });
const before = await calls();
const unknown = await status([V(5), V(6)]);
const refused = await calls();
await status([V(7)]);
await fake('POST', 'set', { failVariant: false });
check('a refused lookup: 1 copy each, and no new lookups for a while', unknown[V(5)]?.copies === 1 && unknown[V(6)]?.copies === 1 && refused > before && (await calls()) === refused, { before, refused, after: await calls() });

/* 6. Staff: reserve for Mere (no plan), list, collected, released, held again */
const forMere = await reserve(STAFF, game(4, 'Catan (Library)', { customerId: MERE, shelfCode: 'DGLF' }));
check('staff reserve a game for Mere, who has no plan', forMere.status === 200 && forMere.data.holds?.length === 1, forMere.data.error);
const list = (await proxy('GET', 'library/holds', { customer: STAFF })).data.holds || [];
const mine = list.filter((h) => [HANA, WIREMU, MERE].includes(h.customerId));
check('the staff list: active holds, soonest first, with names, emails and member codes', mine.length === 4 && mine.every((h) => h.name && h.email && h.code && h.status === 'held') && list.every((h, i) => i === 0 || list[i - 1].until <= h.until), mine.map((h) => [h.title, h.name, h.code]));
check('members can\'t see the staff list (403)', (await proxy('GET', 'library/holds', { customer: HANA })).status === 403);
const wiremuHold = mine.find((h) => h.customerId === WIREMU);
const collected = await proxy('POST', `library/holds/${wiremuHold.id}/update`, { customer: STAFF, body: { status: 'collected', note: 'Took it home' } });
check('collected, with a note', collected.data.hold?.status === 'collected' && collected.data.hold.staffNote === 'Took it home', collected.data);
const mereHold = forMere.data.hold;
const released = await proxy('POST', `library/holds/${mereHold.id}/update`, { customer: STAFF, body: { status: 'released' } });
const heldAgain = await proxy('POST', `library/holds/${mereHold.id}/update`, { customer: STAFF, body: { status: 'held' } });
check('released, then held again with a fresh until', released.data.hold?.status === 'released' && heldAgain.data.hold?.status === 'held' && heldAgain.data.hold.until === holdUntil(Date.now()), [released.data.hold?.status, heldAgain.data.hold?.status]);

/* 7. Hana cancels Wingspan: Wiremu could have it now (but he's at his limit), and My Lair shows what ended */
const cancelled = await proxy('POST', `library/holds/${hold.id}/cancel`, { customer: HANA, body: {} });
check('Hana cancels Wingspan: cancelled, and it\'s back on the shelf', cancelled.status === 200 && cancelled.data.hold?.status === 'cancelled' && (await status([V(1)]))[V(1)]?.available === 1, cancelled.data.hold);
check('someone else can\'t cancel a hold (403)', (await proxy('POST', `library/holds/${azulH.data.hold?.id}/cancel`, { customer: WIREMU, body: {} })).status === 403);
const hanaMe = (await proxy('GET', 'me', { customer: HANA })).data.holds || [];
check('GET /me holds: active first, then the ones that ended lately', hanaMe.length === 2 && hanaMe[0].title === 'Azul (Library)' && hanaMe[0].status === 'held' && hanaMe[1].status === 'cancelled', hanaMe.map((h) => [h.title, h.status]));

// emails: how many the fake holds now, so flow-r6-holds-expiry counts only the ones sent after this
const emailsNow = (await fake('GET', 'emails')).length;
fs.writeFileSync(new URL('./r6-holds.json', import.meta.url), JSON.stringify({ expiring: azulH.data.hold?.id, variant: V(2), title: 'Azul (Library)', member: HANA, email: 'hana.k@example.com', emails: emailsNow }, null, 2));
process.exit(summary() ? 1 : 0);

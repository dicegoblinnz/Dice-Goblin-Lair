// Round 9, community (contract v9-community), HTTP only (no browser), on the real Worker and the fake Admin API: turnouts
// by game, walk-ins, lists of members and early access offers for regulars. Mo: "the more you show up the more you get
// added into our list of say Pokemon turnouts … they will be the ones where we will give the option to buy our products
// before it goes to the rest of the shop".
//   1. turnouts: Hana signs up for tonight's D&D with Wiremu by his member code; nothing counts until staff check them in;
//      then both count under the event's game; undoing the check-in takes them back; checking in again counts again
//   2. walk-ins: Kahu by member code (any case) at tonight's D&D: checked in, the entry fee due at the counter; a second
//      time is refused; another day's date and someone not staff are refused
//   3. lists: save Hana and Wiremu, add Kahu, take him off, rename, the 409 for a name that's taken, delete
//   4. early access: the product search (Shopify's, hidden products too), a draft product refused, an offer for the list
//      (2 units, 1 each), opened with emails ("Early access: …"), only they see it in My Lair, Kahu's claim is a 404, each
//      claim is a draft order made for that customer, the units run out, claiming again replaces (the old checkout is
//      deleted), the paid webhook marks the claim paid (and counts the spend), closing lets the unpaid claim go
// Customers 7941 to 7943 (team uses 7901–7903, play 7911–7912, tab 7921–7923). Run after the seeds (it needs tonight's D&D from the mock events).
import { proxy, fake, check, summary, webhook } from './client.mjs';
import { key, addDays, nextDow, sleep } from './r6-time.mjs';

const STAFF = '7001';
const HANA = '7941'; // signs up and gets early access
const WIREMU = '7942'; // comes along by his code, on the list
const KAHU = '7943'; // a walk-in, not on the offer
const today = key(Date.now());
const TONIGHT = `dnd-tonight@${today}`;
const LATER = `dnd-sunday-10am@${addDays(nextDow(0), 7)}`;
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const run = Date.now() % 100000;
for (const [id, name] of [[HANA, 'Hana Rawiri'], [WIREMU, 'Wiremu Kingi'], [KAHU, 'Kahu Peters']]) {
  await fake('POST', 'customer', { id, tags: [], name, email: `${name.split(' ')[0].toLowerCase()}.r9c@example.com` });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const codes = { hana: (await me(HANA)).member?.code, wiremu: (await me(WIREMU)).member?.code, kahu: (await me(KAHU)).member?.code };
check('setup: three members with codes', Boolean(codes.hana && codes.wiremu && codes.kahu), codes);
const community = async (query = '') => (await proxy('GET', `community${query}`, { customer: STAFF })).data;
const turnoutsOf = async (id, query = '') => ((await community(query)).members || []).find((m) => m.customerId === id)?.turnouts || { m3: 0, m12: 0, all: 0 };
// a clean slate on tonight (an earlier run on the same day signed up already)
for (const who of [HANA, KAHU]) {
  for (const j of (await me(who)).joins || []) if (j.occurrenceId === TONIGHT && j.status !== 'cancelled' && !j.guestOf) await proxy('POST', `events/joins/${j.id}/cancel`, { customer: STAFF, body: {} });
}

/* 1. turnouts */
check('1: not staff: GET /community is a 403', said(await proxy('GET', 'community', { customer: HANA })) === '403 Staff only. Log in with your staff account.');
const before = { hana: await turnoutsOf(HANA), wiremu: await turnoutsOf(WIREMU) };
const signed = await proxy('POST', `events/${TONIGHT}/join`, { customer: HANA, body: { name: 'Hana Rawiri', email: 'hana.r9c@example.com', guests: [{ code: codes.wiremu.toLowerCase() }] } });
const J = signed.data.join || {};
check('1: Hana signs up for tonight with Wiremu by his code', signed.status === 200 && J.people === 2, signed.data.error || J);
check('1: signing up is not a turnout', JSON.stringify(await turnoutsOf(HANA)) === JSON.stringify(before.hana));
const checked = await proxy('POST', 'checkin', { customer: STAFF, body: { id: J.id, type: 'join' } });
check('1: staff check them in', checked.data.checkedIn === true, checked.data);
const after = { hana: await turnoutsOf(HANA), wiremu: await turnoutsOf(WIREMU) };
check('1: checked in: a turnout each, Hana and Wiremu (the member guest counts for himself)', after.hana.m3 === before.hana.m3 + 1 && after.wiremu.m3 === before.wiremu.m3 + 1 && after.hana.all === before.hana.all + 1, { before, after });
const games = (await community()).games || [];
const dnd = games.find((g) => g.key === 'd&d 5e');
check('1: counted under the event\'s game (D&D 5e), with people', Boolean(dnd && dnd.turnouts.m3 >= 2 && dnd.people.m3 >= 2), games);
const oneGame = await community('?game=d%26d%205e&sort=3m');
check('1: one game: only its people, Hana among them', oneGame.game === 'd&d 5e' && oneGame.members.some((m) => m.customerId === HANA) && oneGame.members.every((m) => m.turnouts.all > 0), { game: oneGame.game, n: oneGame.members?.length });
await proxy('POST', `bookings/${J.id}/update`, { customer: STAFF, body: { status: 'confirmed' } });
check('1: undoing the check-in takes the turnouts back', (await turnoutsOf(HANA)).m3 === before.hana.m3 && (await turnoutsOf(WIREMU)).m3 === before.wiremu.m3);
await proxy('POST', 'checkin', { customer: STAFF, body: { id: J.id, type: 'join' } });
check('1: checking in again counts again', (await turnoutsOf(HANA)).m3 === before.hana.m3 + 1);

/* 2. walk-ins */
check('2: not staff: 403', said(await proxy('POST', `events/${TONIGHT}/attend`, { customer: KAHU, body: { code: codes.kahu } })) === '403 Staff only. Log in with your staff account.');
check('2: another day\'s date: 422', /^422 Walk-ins are for today's events\. That one is on \w{3} \d{1,2} \w{3}\.$/.test(said(await proxy('POST', `events/${LATER}/attend`, { customer: STAFF, body: { code: codes.kahu } }))));
check('2: a code nobody has: 404 with the code', said(await proxy('POST', `events/${TONIGHT}/attend`, { customer: STAFF, body: { code: 'zz-nope-1' } })) === '404 No member has the code ZZ-NOPE-1. Check it, or find them under Members.');
const kahuBefore = await turnoutsOf(KAHU);
const walk = await proxy('POST', `events/${TONIGHT}/attend`, { customer: STAFF, body: { code: codes.kahu.toLowerCase().replace(/-/g, '') } });
check('2: Kahu walks in: checked in, $15 to pay at the counter', walk.status === 200 && walk.data.message === 'Walk-in added and checked in: Kahu Peters for Dungeons & Dragons. Charge $15.'
  && walk.data.join.status === 'attended' && walk.data.join.due === 1500 && walk.data.join.source === 'walk-in' && walk.data.row.due === 1500, walk.data);
check('2: the walk-in is a turnout', (await turnoutsOf(KAHU)).m3 === kahuBefore.m3 + 1);
check('2: a second time is refused plainly', said(await proxy('POST', `events/${TONIGHT}/attend`, { customer: STAFF, body: { code: codes.kahu } })) === '409 Kahu Peters is already checked in at Dungeons & Dragons.');
check('2: someone already on a sign-up is pointed at it', said(await proxy('POST', `events/${TONIGHT}/attend`, { customer: STAFF, body: { code: codes.wiremu } })) === '409 Wiremu Kingi is already checked in at Dungeons & Dragons.');
const floor = (await proxy('GET', `floor?from=${Date.now() - 3600000}&to=${Date.now() + 86400000}`, { customer: STAFF })).data;
check('2: the floor has the walk-in\'s sign-up, checked in', (floor.joins || []).some((j) => j.id === walk.data.join.id && j.status === 'attended'));
await proxy('POST', `events/joins/${walk.data.join.id}/cancel`, { customer: STAFF, body: {} });

/* 3. lists */
const name = `Tonight's crew ${run}`;
const made = await proxy('POST', 'community/lists', { customer: STAFF, body: { name, note: 'Round 9 flow', customerIds: [HANA, WIREMU] } });
const L = made.data.list || {};
check('3: a list of Hana and Wiremu', made.status === 200 && L.count === 2 && L.name === name, made.data);
check('3: not staff: 403', (await proxy('POST', 'community/lists', { customer: HANA, body: { name: 'x', customerIds: [] } })).status === 403);
check('3: a name that\'s taken: 409', said(await proxy('POST', 'community/lists', { customer: STAFF, body: { name: name.toUpperCase(), customerIds: [] } })) === `409 There's already a list called ${name.toUpperCase()}. Pick another name.`);
const added = await proxy('POST', `community/lists/${L.id}`, { customer: STAFF, body: { add: [KAHU] } });
check('3: add Kahu', added.data.list?.count === 3, added.data);
const dropped = await proxy('POST', `community/lists/${L.id}`, { customer: STAFF, body: { remove: [KAHU], name: `${name} (Hana and Wiremu)` } });
check('3: take him off and rename it', dropped.data.list?.count === 2 && dropped.data.list?.name === `${name} (Hana and Wiremu)`, dropped.data);
const listed = (await proxy('GET', 'community/lists', { customer: STAFF })).data.lists || [];
check('3: GET /community/lists has it', listed.some((x) => x.id === L.id));
check('3: the community view says who\'s on it', ((await community()).members || []).find((m) => m.customerId === HANA)?.lists.some((x) => x.id === L.id));

/* 4. early access */
await fake('POST', 'product', { id: 99001, title: `QA booster box ${run}`, handle: `qa-booster-box-${run}`, status: 'ACTIVE', published: false, variants: [{ id: 99101, title: 'Default Title', price: '219.00', quantity: 5 }] });
await fake('POST', 'product', { id: 99002, title: `QA draft deck ${run}`, handle: `qa-draft-deck-${run}`, status: 'DRAFT', published: false, variants: [{ id: 99201, title: 'Default Title', price: '50.00', quantity: 1 }] });
const search = await proxy('GET', `products/search?q=${encodeURIComponent(`qa booster box ${run}`)}`, { customer: STAFF });
const found = (search.data.products || [])[0] || {};
check('4: the product search through Shopify: hidden from the online store, active, its variant with price and stock', found.id === '99001' && found.active === true && found.published === false
  && JSON.stringify(found.variants) === JSON.stringify([{ id: '99101', title: '', price: 21900, stock: 5, available: true, image: null }]), search.data);
check('4: a draft product is refused', said(await proxy('POST', 'offers', { customer: STAFF, body: { productId: '99002', variantIds: ['99201'], closes: `${addDays(today, 7)}T18:00`, listId: L.id } }))
  === `422 QA draft deck ${run} is a draft in Shopify, so it can't be sold. Make it Active first: it can stay hidden from the online store.`);
const created = await proxy('POST', 'offers', { customer: STAFF, body: { productId: '99001', variantIds: ['99101'], perPerson: 1, totalUnits: 2, closes: `${addDays(today, 7)}T18:00`, listId: L.id, message: 'One each, friends.', email: true } });
const O = created.data.offer || {};
check('4: an offer for the list: a draft, 2 units, 1 each, no warning (it is hidden online)', created.status === 200 && O.status === 'draft' && O.count === 2 && O.unitsLeft === 2 && created.data.warning === null, created.data);
check('4: a draft is nobody\'s yet', !((await me(HANA)).offers || []).some((o) => o.id === O.id));
const emails0 = (await fake('GET', 'emails')).length;
const opened = await proxy('POST', `offers/${O.id}/open`, { customer: STAFF, body: { email: true } });
check('4: opened, and both emailed', opened.data.offer?.status === 'open' && opened.data.emailed === 2, opened.data);
await sleep(400);
const mails = (await fake('GET', 'emails')).slice(emails0);
const toHana = mails.find((e) => [].concat(e.to).includes('hana.r9c@example.com'));
check('4: the email: "Early access: <product>", Gobgob saved them a spot, grab it in My Lair before…', toHana && toHana.subject === `Early access: QA booster box ${run}` && /Gobgob saved you a spot before anyone else\./.test(toHana.text) && /Grab it in My Lair before \w+ \d{1,2} \w+, 6pm\./.test(toHana.text), toHana ? toHana.text.slice(0, 300) : mails.map((e) => e.subject));
check('4: Kahu isn\'t emailed', !mails.some((e) => [].concat(e.to).includes('kahu.r9c@example.com')));
const hanaOffer = ((await me(HANA)).offers || []).find((o) => o.id === O.id);
check('4: Hana\'s My Lair has it: limit 1, 2 units left, no claim', hanaOffer && hanaOffer.limit === 1 && hanaOffer.unitsLeft === 2 && hanaOffer.claim === null && hanaOffer.variants[0].price === 21900, hanaOffer);
check('4: Kahu\'s doesn\'t, and his claim is a 404', !((await me(KAHU)).offers || []).some((o) => o.id === O.id) && said(await proxy('POST', `offers/${O.id}/claim`, { customer: KAHU, body: { variantId: '99101', quantity: 1 } })) === '404 That offer could not be found.');
check('4: more than the limit: 422', said(await proxy('POST', `offers/${O.id}/claim`, { customer: HANA, body: { variantId: '99101', quantity: 2 } })) === '422 Pick how many: 1 to 1.');
const c1 = await proxy('POST', `offers/${O.id}/claim`, { customer: HANA, body: { variantId: '99101', quantity: 1 } });
check('4: Hana claims one: waiting, with her checkout link', c1.status === 200 && c1.data.claim.status === 'waiting' && /\/__checkout\/\d+$/.test(c1.data.claim.checkoutUrl || ''), c1.data);
const drafts = async () => Object.values((await fetch('http://127.0.0.1:8799/__fake/state').then((r) => r.json())).drafts || {});
const draftOf = async (claimId) => (await drafts()).find((d) => (d.input?.customAttributes || []).some((a) => a.key === '_offer_claim' && a.value === claimId));
const d1 = await draftOf(c1.data.claim.id);
check('4: the draft order is made for Hana\'s own account: one line, the variant and quantity, tagged lair-offer', d1 && d1.input.purchasingEntity?.customerId === `gid://shopify/Customer/${HANA}`
  && d1.input.lineItems.length === 1 && d1.input.lineItems[0].variantId === 'gid://shopify/ProductVariant/99101' && d1.input.lineItems[0].quantity === 1 && d1.input.tags.includes('lair-offer'), d1?.input);
check('4: Wiremu\'s My Lair never has Hana\'s link', !JSON.stringify(await me(WIREMU)).includes(c1.data.claim.checkoutUrl));
const c2 = await proxy('POST', `offers/${O.id}/claim`, { customer: WIREMU, body: { quantity: 1 } });
check('4: Wiremu claims the last one (one option: no need to say which)', c2.status === 200 && c2.data.offer.unitsLeft === 0, c2.data);
const again = await proxy('POST', `offers/${O.id}/claim`, { customer: HANA, body: { variantId: '99101', quantity: 1 } });
await sleep(300);
const d1now = (await drafts()).find((d) => d.id === d1.id);
check('4: Hana claiming again replaces her claim: a new checkout, the old one deleted', again.status === 200 && again.data.claim.id !== c1.data.claim.id && d1now?.status === 'DELETED', { again: again.data, old: d1now?.status });
const d2 = await draftOf(again.data.claim.id);
const order = 99500 + (run % 400);
await fake('POST', 'draft-paid', { draftId: d2.id, orderId: `gid://shopify/Order/${order}` });
await fake('POST', 'order', { id: order, customerId: HANA, subtotal: 21900, source: 'shopify_draft_order' });
const spendBefore = ((await community('?sort=spend')).members || []).find((m) => m.customerId === HANA)?.spend || 0;
const hook = await webhook({ id: order, source_name: 'shopify_draft_order', note: 'Lair early access claim', note_attributes: [{ name: '_offer_claim', value: again.data.claim.id }],
  line_items: [{ id: order * 10, title: `QA booster box ${run}`, price: '219.00', quantity: 1, properties: [{ name: '_offer_claim', value: again.data.claim.id }] }] });
check('4: the paid webhook is taken', hook.status === 200, hook);
const detail = (await proxy('GET', `offers/${O.id}`, { customer: STAFF })).data;
const paidClaim = (detail.claims || []).find((c) => c.id === again.data.claim.id);
check('4: the claim is paid (staff see it: who, paid)', paidClaim?.status === 'paid' && paidClaim.name === 'Hana Rawiri' && detail.offer.claimed.paid === 1, detail.claims);
const hanaNow = ((await me(HANA)).offers || []).find((o) => o.id === O.id);
check('4: Hana\'s My Lair: paid, no link', hanaNow?.claim?.status === 'paid' && hanaNow.claim.checkoutUrl === null && hanaNow.bought === 1, hanaNow);
check('4: her spend counts the order', (((await community('?sort=spend')).members || []).find((m) => m.customerId === HANA)?.spend || 0) === spendBefore + 21900);
const closed = await proxy('POST', `offers/${O.id}/close`, { customer: STAFF, body: {} });
await sleep(300);
const d3 = await draftOf(c2.data.claim.id);
check('4: closing lets Wiremu\'s unpaid claim go, and his checkout is deleted', closed.data.released === 1 && closed.data.offer.status === 'closed' && d3?.status === 'DELETED', { released: closed.data.released, draft: d3?.status });
check('4: a closed offer leaves My Lair', !((await me(WIREMU)).offers || []).some((o) => o.id === O.id));
await proxy('POST', `community/lists/${L.id}/remove`, { customer: STAFF, body: {} });
check('3: the list is deleted', !((await proxy('GET', 'community/lists', { customer: STAFF })).data.lists || []).some((x) => x.id === L.id));

process.exit(summary() ? 1 : 0);

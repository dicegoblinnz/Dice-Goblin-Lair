// Round 7, backend-a (contract v7.1, sections 1 to 7), HTTP only (no browser), on the real Worker and the fake Admin API:
//   1. mobile numbers on every customer booking (and none on what staff make); a member's new one lands on their profile
//   2. the player profile (pronouns, favourite games, about me); staff see it, a GM sees only what they should
//   3. loot codes ("roll codes"): staff make ROLL-FOR-LOOT and a limited code; "Got a code?" takes loot, pass and gift codes
//   4. the loyalty card's number
//   5. birthday gifts in words; a product code used on an order (orders/paid with discountCodes) turns the gift "claimed"
//   6. library holds until midnight on the third day, games at home, scanning to borrow and return (LairVariantByCode),
//      staff check-out and check-in, and Shopify refusing the lookup (read_products not approved yet)
//   7. the tab's barcode lookup
import { proxy, webhook, fake, check, summary } from './client.mjs';
import { key, addDays, at, nextDow, holdUntil, longWhen, pageWhen, sleep, TZ } from './r6-time.mjs';

const STAFF = '7001';
const MERE = '7341'; // Mereana Walker: a Stash library member
const HONE = '7342'; // Hone Parata: a library-member (1 game)
const TAI = '7343'; // Tai Ruru: no library plan
const PIRI = '7344'; // Piri Moana: a GM's player
const run = Date.now() % 100000;
const today = key(Date.now());
const D = addDays(today, 12);
const SAT = addDays(nextDow(6, today, 2), 21);
const THU = addDays(nextDow(4, today, 2), 21);
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const MISSING = 'Add a mobile number so we can reach you on the day.';
const WRONG = "That mobile number doesn't look right. Try one like 021 123 4567.";
for (const [id, tags, name] of [[MERE, ['Simplee: Stash'], 'Mereana Walker'], [HONE, ['library-member'], 'Hone Parata'], [TAI, [], 'Tai Ruru'], [PIRI, [], 'Piri Moana']]) {
  await fake('POST', 'customer', { id, tags, name, email: `${name.split(' ')[0].toLowerCase()}.r7@example.com` });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;

/* 1. Mobile numbers */
const table = (body) => ({ kind: 'table', tables: ['T21'], start: at(D, 18), end: at(D, 20), people: 2, name: 'Mereana Walker', email: 'mereana.r7@example.com', ...body });
check('1: a table booking with no mobile: 422 with the words', said(await proxy('POST', 'bookings', { customer: MERE, body: table({ phone: undefined }) })) === `422 ${MISSING}`);
check('1: a landline: 422 with the words', said(await proxy('POST', 'bookings', { customer: MERE, body: table({ phone: '09 123 4567' }) })) === `422 ${WRONG}`);
const booked = await proxy('POST', 'bookings', { customer: MERE, body: table({ phone: ' 021  555 0301 ' }) });
check('1: with a mobile it\'s booked', booked.status === 200 && booked.data.booking?.status === 'confirmed', booked.data.error);
const floorAfter = (await proxy('GET', `floor?from=${at(D, 0)}&to=${at(addDays(D, 1), 0)}`, { customer: STAFF })).data;
check('1: staff see it on the booking, tidied (runs of spaces made one)', floorAfter.bookings?.find((b) => b.id === booked.data.booking?.id)?.phone === '021 555 0301', floorAfter.bookings?.find((b) => b.id === booked.data.booking?.id)?.phone);
check('1: and it\'s on her player profile now', (await me(MERE)).profile?.mobile === '021 555 0301', (await me(MERE)).profile);
const staffMade = await proxy('POST', 'bookings', { customer: STAFF, body: table({ tables: ['T20'], phone: undefined, staffOverride: true, name: 'Phoned in', email: '' }) });
check('1: staff making a booking for someone (staffOverride) need no mobile', staffMade.status === 200, staffMade.data.error);
const signUpDay = `dnd-saturday-6pm@${SAT}`;
check('1: an event sign-up needs one', said(await proxy('POST', `events/${signUpDay}/join`, { customer: TAI, body: { name: 'Tai Ruru', email: 'tai.r7@example.com', people: 1, phone: undefined } })) === `422 ${MISSING}`);
const signed = await proxy('POST', `events/${signUpDay}/join`, { customer: TAI, body: { name: 'Tai Ruru', email: 'tai.r7@example.com', people: 1, phone: '+44 7911 123456' } });
check('1: a visitor\'s overseas mobile is fine', signed.status === 200, signed.data.error);
const joins = (await proxy('GET', `floor?from=${at(SAT, 0)}&to=${at(addDays(SAT, 1), 0)}`, { customer: STAFF })).data.joins || [];
check('1: staff see the sign-up\'s mobile', joins.find((j) => j.id === signed.data.join?.id)?.phone === '+44 7911 123456', joins.map((j) => j.phone));
const spotDay = `warhammer-wargames@${THU}`;
check('1: an event game spot needs one', said(await proxy('POST', `events/${spotDay}/reserve`, { customer: TAI, body: { name: 'Tai Ruru', email: 'tai.r7@example.com', people: 1, phone: undefined } })) === `422 ${MISSING}`);

/* 2. The player profile, and what a GM sees */
const saved = await proxy('POST', 'me/profile', { customer: PIRI, body: { name: 'Piri Moana', mobile: '027 555 0302', birthday: '03-14', pronouns: 'they/them', favouriteGames: ['Root', 'root', 'Mothership'], about: 'Plays a mean bard.' } });
check('2: the profile saves, repeats dropped', saved.status === 200 && saved.data.profile?.pronouns === 'they/them' && saved.data.profile.favouriteGames.join() === 'Root,Mothership' && saved.data.profile.mobile === '027 555 0302', saved.data.error || saved.data.profile);
const listed = await proxy('POST', 'games', { customer: '7103', body: { title: `Mothership (r7 ${run})`, system: 'Mothership', gm: 'Ana', email: 'ana@example.com', blurb: 'Space horror.', seats: 4, tables: ['G1'], start: at(D, 19), end: at(D, 22), gmFee: 500 } });
const seat = await proxy('POST', 'bookings', { customer: PIRI, body: { kind: 'gm-seat', gameId: listed.data.game?.id, people: 1, name: 'Piri Moana', email: 'piri.r7@example.com', phone: '027 555 0302' } });
check('2: Piri joins Ana\'s session', seat.status === 200, seat.data.error);
const anaGames = (await me('7103')).games || [];
const player = anaGames.find((g) => g.id === listed.data.game?.id)?.players?.[0];
check('2: the GM sees Piri\'s pronouns, favourite games and about me, on an account, not a regular', player && player.member === true && player.regular === false && player.pronouns === 'they/them' && player.about === 'Plays a mean bard.', player);
check('2: never their mobile, email or birthday', player && !JSON.stringify(player).includes('027') && !JSON.stringify(player).includes('@') && !JSON.stringify(player).includes('03-14'), player);
const piriStaff = ((await proxy('GET', `members?q=${PIRI}`, { customer: STAFF })).data || [])[0];
check('2: staff see it all on the member', piriStaff?.mobile === '027 555 0302' && piriStaff.pronouns === 'they/them' && piriStaff.about === 'Plays a mean bard.', piriStaff && [piriStaff.mobile, piriStaff.pronouns]);

/* 3. Loot codes and "Got a code?" */
const all = (await proxy('GET', 'roll-codes?status=all', { customer: STAFF })).data.codes || [];
let welcome = all.find((c) => c.code === 'ROLL-FOR-LOOT');
if (!welcome) welcome = (await proxy('POST', 'roll-codes', { customer: STAFF, body: { code: 'roll-for-loot', note: "Gobgob's welcome loot, for every customer" } })).data.code;
check('3: staff make the welcome code ROLL-FOR-LOOT: 1 roll, no limit, no expiry', welcome?.code === 'ROLL-FOR-LOOT' && welcome.rolls === 1 && welcome.limit === null && welcome.expiresAt === null, welcome);
check('3: members can\'t make codes (403)', (await proxy('POST', 'roll-codes', { customer: MERE, body: {} })).status === 403);
const taken = await proxy('POST', 'roll-codes', { customer: STAFF, body: { code: 'ROLLFORLOOT' } });
check('3: a code that\'s taken (any way it\'s typed): 409', said(taken) === "409 That code's taken. Pick another, or leave it empty and Gobgob will make one.");
const once = (await proxy('POST', 'roll-codes', { customer: STAFF, body: { rolls: 2, limit: 1, note: `QA ${run}` } })).data.code;
check('3: Gobgob makes one like GG-KOBOLD-14 (2 rolls, 1 use in all)', /^GG-[A-Z]+-\d{1,2}$/.test(once?.code || '') && once.rolls === 2 && once.limit === 1, once);
const before3 = (await me(MERE)).loyalty;
check('3: no welcome roll by itself any more', before3?.rolls?.earned?.welcome === 0, before3?.rolls);
const loot = await proxy('POST', 'me/codes/redeem', { customer: MERE, body: { code: 'roll for loot' } });
check('3: "Got a code?": the loot code\'s roll, in Gobgob\'s words', loot.status === 200 && loot.data.kind === 'roll' && loot.data.rolls === 1 && loot.data.message === "Loot! That's 1 roll for your loyalty card. Roll it on Home, friend.", loot.data);
check('3: its loyalty: one more roll, from codes', loot.data.loyalty?.rolls?.earned?.codes === 1 && loot.data.loyalty.rolls.available === (before3?.rolls?.available || 0) + 1, loot.data.loyalty?.rolls);
check('3: once each (409)', said(await proxy('POST', 'me/codes/redeem', { customer: MERE, body: { code: 'ROLL-FOR-LOOT' } })) === "409 You've used that code already. It's one go each.");
const two = await proxy('POST', 'me/codes/redeem', { customer: MERE, body: { code: once?.code } });
check('3: two rolls: "Roll them on Home"', two.data.message === "Loot! That's 2 rolls for your loyalty card. Roll them on Home, friend.", two.data);
check('3: a code used up: 410', said(await proxy('POST', 'me/codes/redeem', { customer: HONE, body: { code: once?.code } })) === "410 That code isn't working any more. Ask us at the counter.");
const unknown = await proxy('POST', 'me/codes/redeem', { customer: HONE, body: { code: 'NOT-A-CODE-9' } });
check('3: a code nobody knows: 404 in Gobgob\'s words', said(unknown) === "404 Gobgob doesn't know that code. Check it and try again.");
check('3: a loot code is never a ticket (check-in 404)', (await proxy('POST', 'checkin', { customer: STAFF, body: { code: 'ROLL-FOR-LOOT' } })).status === 404);
const staffCodes = (await proxy('GET', 'roll-codes', { customer: STAFF })).data.codes || [];
check('3: staff see the uses (newest first, with the member code)', staffCodes.find((c) => c.id === welcome?.id)?.recent?.some((r) => r.customerId === MERE && r.name === 'Mereana Walker' && r.code), staffCodes.find((c) => c.id === welcome?.id)?.recent);
// A session gift's code goes in the same box
let next = 310000 + (run % 1000) * 10; // order ids no other flow uses
next += 1;
await fake('POST', 'order', { id: next, customerId: null, subtotal: 5000, source: 'pos', name: `#R7G${next}` });
const giftOrder = await webhook({ id: next, source_name: 'pos', line_items: [{ id: next * 10, title: 'Session gift', sku: 'LAIR-GIFT-5', price: '50.00', quantity: 1, properties: [] }] });
const giftCode = giftOrder.data?.gifts?.[0];
const claimed = await proxy('POST', 'me/codes/redeem', { customer: HONE, body: { code: giftCode } });
check('3: a session gift\'s code: added to the wallet, exactly as claiming', claimed.status === 200 && claimed.data.kind === 'pass' && claimed.data.pass?.code === giftCode && claimed.data.message === 'Added to your wallet: Gift: 5 sessions.', claimed.data);

/* 4. The loyalty card's number */
check('4: loyalty.card is the card they\'re on', (await me(MERE)).loyalty?.card === ((await me(MERE)).loyalty?.cards || 0) + 1);

/* 5. Birthday gifts in words, and a used product code */
await fake('POST', 'set', { failDiscount: false, failCredit: false });
const given = await proxy('POST', `members/${MERE}/gift`, { customer: STAFF, body: { credit: 20, rolls: 5, productVariantId: '50371432939623', productTitle: 'Riftbound – Vendetta Booster Pack', note: 'Happy birthday!' } });
const gift = given.data.gift || {};
const code = gift.product?.code || '';
check('5: the gift in words', given.status === 200 && /^HBD-/.test(code) && gift.words === `$20 store credit, 5 rolls, Riftbound – Vendetta Booster Pack (code ${code}, until ${new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(gift.at + 30 * 86400000))})` && gift.state === 'ready', gift.words || given.data.error);
check('5: "Got a code?" says a gift\'s product code is for the shop', said(await proxy('POST', 'me/codes/redeem', { customer: MERE, body: { code } })) === "422 That's a shop discount code. Use it at checkout online, or show it at the counter.");
const ready = (await me(MERE)).gifts?.find((g) => g.id === gift.id);
check('5: My Lair: the full card while there\'s something to collect', ready?.state === 'ready' && ready.product?.status === 'ready' && ready.words === gift.words, ready);
next += 1;
await fake('POST', 'order', { id: next, customerId: MERE, subtotal: 0, source: 'pos', name: `#R7U${next}`, discountCodes: [code.toLowerCase()] });
const used = await webhook({ id: next, source_name: 'pos', line_items: [] });
check('5: orders/paid notices the code on the order (any case)', used.status === 200 && used.data?.giftCodes?.[0] === code, used.data);
const claimedGift = (await me(MERE)).gifts?.find((g) => g.id === gift.id);
check('5: the gift is claimed: one line, "used <date>"', claimedGift?.state === 'claimed' && claimedGift.product?.status === 'used' && claimedGift.words.endsWith(`(code ${code}, used ${new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date())})`), claimedGift);
const detail = (await proxy('GET', `members/${MERE}`, { customer: STAFF })).data.member;
check('5: the member\'s page: every gift, with the order that used the code, and this year\'s in words', detail?.gifts?.[0]?.product?.order === `#R7U${next}` && detail.giftsThisYear?.[0]?.words === claimedGift?.words, detail && [detail.gifts?.[0]?.product, detail.giftsThisYear]);
check('5: GET /members/:customerId is staff only (403) and knows its members (404)', (await proxy('GET', `members/${MERE}`, { customer: MERE })).status === 403 && (await proxy('GET', 'members/9999999', { customer: STAFF })).status === 404);
await proxy('POST', 'me/profile', { customer: TAI, body: { name: 'Tai Ruru', birthday: addDays(today, 3).slice(5) } });
const birthdays = (await proxy('GET', 'members/birthdays', { customer: STAFF })).data || [];
check('5: birthdays suggest no rolls (round 7)', birthdays.some((b) => b.customerId === TAI) && birthdays.every((b) => b.suggested?.rolls === 0), birthdays.map((b) => [b.customerId, b.suggested]));

/* 6. Library: holds until midnight, games at home, scanning */
const V = (n) => String(47000000 + (run % 1000) * 10 + n);
const shelf = (n) => `DGL34-${String(500 + (run % 100) * 4 + n).padStart(3, '0')}`;
await fake('POST', 'variant', { id: V(1), quantity: 1, tracked: true });
await fake('POST', 'variant', { id: V(2), quantity: 1, tracked: true });
await fake('POST', 'variant-code', { id: V(2), productId: '92002', handle: `azul-library-${run}`, productTitle: 'Azul (Library)', sku: shelf(2), barcode: shelf(2), libraryCode: shelf(2), productImage: 'https://cdn.shopify.com/s/files/1/azul.jpg', price: '0.00' });
await fake('POST', 'variant-code', { id: V(9), productId: '92009', handle: 'pocky', productTitle: 'Pocky (Strawberry)', sku: `SNK-${run}`, barcode: `93${run}017`, price: '4.50', productImage: 'https://cdn.shopify.com/s/files/1/pocky.jpg' });
const made = Date.now();
const hold = await proxy('POST', 'library/holds', { customer: MERE, body: { variantId: V(1), productId: '92001', title: 'Wingspan', shelfCode: shelf(1), handle: `wingspan-library-${run}`, image: '//www.dicegoblin.nz/cdn/shop/files/wingspan.jpg' } });
const until = holdUntil(made);
check('6: a hold lasts until midnight at the end of the third day, today counting as the first', hold.status === 200 && hold.data.hold?.until === until && hold.data.hold.image === 'https://www.dicegoblin.nz/cdn/shop/files/wingspan.jpg', hold.data.error || [hold.data.hold?.until, until, hold.data.hold?.image]);
check('6: and says so ("midnight, <day before>")', (await proxy('POST', 'library/holds', { customer: MERE, body: { variantId: V(1), title: 'Wingspan', shelfCode: shelf(1) } })).data.error === `You've already reserved this one, friend. It's held until ${pageWhen(until)}.`);
await sleep(800);
const holdMail = (await fake('GET', 'emails')).filter((e) => [].concat(e.to).includes('mereana.r7@example.com') && /Wingspan is on hold for you/.test(e.subject)).pop();
check('6: the member\'s email: "until midnight on <weekday day month>", and a button to My Library', holdMail?.text?.includes(`Wingspan is on hold for you until ${longWhen(until)}.`) && /my-lair\?view=library/.test(holdMail.text), holdMail?.text?.slice(0, 300));
const collected = await proxy('POST', `library/holds/${hold.data.hold?.id}/update`, { customer: STAFF, body: { status: 'collected' } });
check('6: collected: the game is at home, a loan linked to the hold', collected.data.hold?.status === 'collected' && collected.data.loan?.status === 'out' && collected.data.loan.holdId === hold.data.hold?.id && collected.data.hold.loanId === collected.data.loan.id, collected.data);
const st1 = (await proxy('GET', `library/status?ids=${V(1)}`, { customer: MERE })).data.games?.[V(1)];
check('6: the status: 1 copy, out 1, none on the shelf, and it\'s at home with her', st1 && st1.copies === 1 && st1.out === 1 && st1.available === 0 && st1.nextFree === null && st1.atHome?.id === collected.data.loan?.id, st1);
check('6: anyone else: "Every copy is out on loan right now"', (await proxy('POST', 'library/holds', { customer: HONE, body: { variantId: V(1), title: 'Wingspan' } })).data.error === 'Every copy is out on loan right now. Check back soon, friend.');
// Hone borrows Azul by scanning it: the Lair asks Shopify (LairVariantByCode), then knows it
const borrow = await proxy('POST', 'library/scan', { customer: HONE, body: { code: shelf(2).toLowerCase() } });
check('6: scanning a library copy borrows it ("yours to take home")', borrow.status === 200 && borrow.data.result === 'borrowed' && borrow.data.loan?.title === 'Azul' && borrow.data.message === 'Azul is yours to take home. Scan it again when you bring it back.' && borrow.data.library?.atHome?.length === 1, borrow.data.error || borrow.data);
check('6: his plan (1 game) is full now', (await proxy('POST', 'library/holds', { customer: HONE, body: { variantId: V(3), title: 'Root' } })).data.error === "Your plan has 1 game at a time, and you've got 1: 1 at home. Return one or cancel a hold first.");
const lookups = async () => (await fake('GET', 'calls')).filter((c) => c.op === 'LairVariantByCode').length;
const asked = await lookups();
const back = await proxy('POST', 'library/scan', { customer: HONE, body: { code: shelf(2) } });
check('6: scanning it again returns it, without asking Shopify again', back.data.result === 'returned' && back.data.message === 'Azul is checked back in. Thanks, friend!' && (await lookups()) === asked, back.data);
check('6: the shop\'s products aren\'t library games (422)', said(await proxy('POST', 'library/scan', { customer: HONE, body: { code: `93${run}017` } })) === "422 That's from the shop, not the library. Borrow games from the library shelves.");
check('6: no plan, no borrowing (403)', (await proxy('POST', 'library/scan', { customer: TAI, body: { code: shelf(2) } })).status === 403);
// Staff: check Azul out to Tai at the counter (no plan: a notice, not a no), then in by scanning
const out = await proxy('POST', 'library/loans', { customer: STAFF, body: { customerId: TAI, code: shelf(2) } });
check('6: staff check a game out at the counter, with a notice when it\'s outside a plan', out.status === 200 && out.data.loan?.name === 'Tai Ruru' && out.data.notice === "Tai isn't on a library plan.", out.data);
const loans = (await proxy('GET', 'library/loans', { customer: STAFF })).data.loans || [];
check('6: the staff list of games at home, with days', loans.some((l) => l.id === out.data.loan?.id && l.days === 0) && loans.some((l) => l.id === collected.data.loan?.id), loans.map((l) => [l.title, l.name, l.days]));
const checkedIn = await proxy('POST', 'library/return', { customer: STAFF, body: { code: shelf(2) } });
check('6: staff check it in by scanning (one out: it\'s back)', checkedIn.data.result === 'returned' && checkedIn.data.loan?.customerId === TAI, checkedIn.data);
const shelfIt = await proxy('POST', `library/loans/${collected.data.loan?.id}/return`, { customer: STAFF, body: {} });
check('6: "Back on the shelf" for any loan', shelfIt.data.loan?.status === 'returned', shelfIt.data);

/* 7. The tab's scanner */
const pocky = await proxy('GET', `tab/lookup?code=93${run}017`, { customer: MERE });
check('7: a barcode becomes a tab item', pocky.status === 200 && pocky.data.item?.variantId === V(9) && pocky.data.item.price === 450 && pocky.data.item.variantTitle === '' && pocky.data.item.title === 'Pocky (Strawberry)' && pocky.data.item.image === 'https://cdn.shopify.com/s/files/1/pocky.jpg', pocky.data);
check('7: a library game isn\'t a tab item (422)', said(await proxy('GET', `tab/lookup?code=${shelf(2)}`, { customer: MERE })) === "422 That's one of our library games, so it doesn't go on a tab. Borrow it in My Library.");
const nobody = await proxy('GET', `tab/lookup?code=00${run}404`, { customer: MERE });
check('7: a code nobody knows (404)', said(nobody) === "404 Gobgob doesn't know that one. Pick it from the menu instead.", said(nobody));
check('7: logged out (401)', (await proxy('GET', `tab/lookup?code=93${run}017`)).status === 401);

/* 6 and 7: Shopify refusing the lookup (read_products not approved yet): a 503, then 10 minutes before the Lair asks
   again, and the games it already knows still scan. Last, because the rest lasts the 10 minutes. */
await fake('POST', 'set', { failVariantCode: true });
const down = await proxy('POST', 'library/scan', { customer: HONE, body: { code: `DGL56-${run}` } });
check('6: Shopify refuses the lookup: 503 with the words', said(down) === "503 Gobgob can't look that game up just now. Ask at the counter and we'll sort it.", said(down));
const known = await proxy('POST', 'library/scan', { customer: HONE, body: { code: shelf(2) } });
check('6: a game the Lair knows still scans', known.data.result === 'borrowed', known.data);
await proxy('POST', 'library/scan', { customer: HONE, body: { code: shelf(2) } });
await fake('POST', 'set', { failVariantCode: false });
const resting = await lookups();
const later = await proxy('GET', `tab/lookup?code=00${run}503`, { customer: MERE });
check('7: for 10 minutes it doesn\'t ask Shopify again: a 503 (the theme falls back to the store\'s search)', said(later) === "503 Gobgob can't look up barcodes just now. Pick it from the menu instead." && (await lookups()) === resting, said(later));

process.exit(summary() ? 1 : 0);

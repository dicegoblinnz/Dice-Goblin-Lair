// The Today roster: grouping, counts, badges, search and passes: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areYou,
  canGmPay,
  countRows,
  dayBuckets,
  findRow,
  finishedLine,
  gameTitle,
  gmPaysChoice,
  gmPaysFor,
  groupBadges,
  groupDetails,
  groupSummary,
  isHeld,
  isOwed,
  isPayOnly,
  mergeRows,
  newerTileEntry,
  owedWhen,
  passCandidates,
  passSummary,
  passUsable,
  playerNames,
  replaceRows,
  rowBadges,
  rowDetails,
  rowKey,
  rowState,
  searchToday,
  sortGroups,
  sortRows,
  tileEntry,
  tileWords,
  whatLabel,
  withCover,
} from '../extensions/lair-checkin/src/today.js';

// 3 Oct 2026 is NZDT (UTC+13): 05:00 UTC is 6pm in Auckland.
const at = (hourNz) => Date.UTC(2026, 9, 3, hourNz - 13, 0);

const pass = { code: 'SJ-KIWI-4', label: 'Warhammer league', left: 7 };

function fixture() {
  return {
    day: '2026-10-03',
    now: at(17),
    groups: [
      {
        key: 'game:gm_1',
        kind: 'game',
        title: 'Curse of Strahd · GM Kate',
        start: at(18),
        end: at(22),
        tables: ['T7', 'T8'],
        rows: [
          { id: 'bk_cleo', type: 'booking', ref: 'CL-OTTER-3', name: 'Cleo Park', people: 1, start: at(18), end: at(22), status: 'noshow', due: 1500 },
          { id: 'bk_ben', type: 'booking', ref: 'BE-MIMIC-9', name: 'Ben Ng', people: 1, start: at(18), end: at(22), status: 'seated', arrivedAt: at(17), paid: true, due: 0 },
          {
            id: 'bk_ana',
            type: 'booking',
            ref: 'AN-GOLEM-12',
            name: 'Ana Silva',
            people: 2,
            start: at(18),
            end: at(22),
            status: 'confirmed',
            due: 3000,
            customerId: '555',
            players: [{ name: 'Ana', character: 'Grog' }, { name: 'Jo' }],
          },
        ],
      },
      {
        key: 'tables',
        kind: 'tables',
        title: 'Table bookings',
        start: at(11),
        end: at(23),
        tables: [],
        rows: [
          { id: 'bk_sam', type: 'booking', ref: 'SJ-OWLBEAR-17', name: 'Sam Jones', people: 3, tables: ['T4'], start: at(19), end: at(22), status: 'confirmed', due: 4500, customerId: '777', pass },
          { id: 'bk_walk', type: 'booking', ref: 'WA-TOAD-2', name: 'Walk-in', people: 2, tables: ['T2'], start: at(11), end: at(13), status: 'seated', arrivedAt: at(11), paid: true, due: 0 },
        ],
      },
      {
        key: 'event:ev_1@2026-10-03',
        kind: 'event',
        title: 'Pokémon TCG league',
        start: at(17),
        end: at(20),
        tables: ['T14', 'T15'],
        rows: [
          { id: 'ej_jo', type: 'join', ref: 'JO-PIXIE-1', name: 'Jo Bloggs', people: 1, start: at(17), end: at(20), status: 'confirmed', due: 1000 },
          { id: 'bk_zoe', type: 'booking', ref: 'ZB-KEA-20', name: 'Zoë van der Berg', people: 2, tables: ['T14'], start: at(17), end: at(20), status: 'seated', arrivedAt: at(17), due: 3000 },
          { id: 'ej_rae', type: 'join', ref: 'RA-WAND-5', name: 'Rae Kim', people: 1, start: at(17), end: at(20), status: 'noshow', paid: true, due: 0, refund: 'ask' },
        ],
      },
    ],
  };
}

test('groups come in time order, games before events before tables at the same time', () => {
  const today = fixture();
  assert.deepEqual(sortGroups(today.groups).map((g) => g.key), ['tables', 'event:ev_1@2026-10-03', 'game:gm_1']);
  const sameTime = [
    { key: 't', kind: 'tables', start: 1, rows: [] },
    { key: 'e', kind: 'event', start: 1, rows: [] },
    { key: 'g', kind: 'game', start: 1, rows: [] },
  ];
  assert.deepEqual(sortGroups(sameTime).map((g) => g.key), ['g', 'e', 't']);
});

test('each group shows people here out of people booked, and money still due', () => {
  const [game, tables, event] = fixture().groups;
  // Ana 2 + Ben 1 + Cleo 1 booked; Ben is here; Cleo is a no-show, so her $15 isn't counted as due.
  assert.equal(groupSummary(game), '1 of 4 here · $30 to pay');
  assert.equal(groupSummary(tables), '2 of 5 here · $45 to pay');
  // Zoë is here but hasn't paid yet; Rae paid and didn't come (a refund to sort out, not money due).
  assert.equal(groupSummary(event), '2 of 4 here · $40 to pay');
  assert.equal(groupSummary({ key: 'x', rows: [] }), 'No one booked yet');
  assert.deepEqual(countRows(tables.rows), { people: 5, arrived: 2, due: 4500 });
  assert.equal(groupDetails(game), '6pm–10pm · T7, T8');
  assert.equal(groupDetails(tables), '2 bookings');
});

test('the home screen: now and next, later today, and finished', () => {
  const [game, tables, event] = fixture().groups;
  const later = { key: 'event:ev_9', kind: 'event', title: 'Board game night', start: at(21), end: at(23), rows: [] };
  const done = { key: 'event:ev_0', kind: 'event', title: 'Learn to play', start: at(10), end: at(12), rows: [] };
  // At 5pm: the Pokémon league (5pm), the table bookings (all day) and Strahd (6pm) are now and next; 9pm is later.
  const buckets = dayBuckets([game, tables, event, later, done], at(17));
  assert.deepEqual(buckets.now.map((g) => g.key), ['tables', 'event:ev_1@2026-10-03', 'game:gm_1']);
  assert.deepEqual(buckets.later.map((g) => g.key), ['event:ev_9']);
  assert.deepEqual(buckets.finished.map((g) => g.key), ['event:ev_0']);
  // At 7pm the 9pm one is within two hours: now and next.
  assert.deepEqual(dayBuckets([later], at(19)).now.map((g) => g.key), ['event:ev_9']);
  assert.deepEqual(dayBuckets([], at(19)), { now: [], later: [], finished: [] });
});

test('a group on the home screen: who’s here and what’s to pay, or when it starts', () => {
  const [game, tables, event] = fixture().groups;
  assert.deepEqual(groupBadges(game, at(17)), [{ tone: 'neutral', text: '1 of 4 here' }, { tone: 'warning', text: '$30 to pay' }], 'Ben came early');
  assert.deepEqual(groupBadges({ ...game, rows: game.rows.filter((r) => r.id !== 'bk_ben') }, at(17)), [
    { tone: 'info', text: 'Starts at 6pm' },
    { tone: 'neutral', text: '3 booked' },
    { tone: 'warning', text: '$30 to pay' },
  ]);
  assert.deepEqual(groupBadges(tables, at(17)), [{ tone: 'neutral', text: '2 of 5 here' }, { tone: 'warning', text: '$45 to pay' }]);
  const everyone = { ...event, rows: [{ id: 'x', people: 2, status: 'seated', arrivedAt: at(17), due: 0, paid: true }] };
  assert.deepEqual(groupBadges(everyone, at(18)), [{ tone: 'success', text: '2 of 2 here' }]);
  assert.deepEqual(groupBadges({ key: 'x', rows: [] }, at(18)), [{ tone: 'neutral', text: 'No one booked yet' }]);
  assert.equal(finishedLine({ ...everyone, title: 'Learn to play' }), 'Learn to play · 2 people · all paid');
  assert.equal(finishedLine(tables), 'Table bookings · 5 people · $45 to pay');
  assert.equal(finishedLine(game), 'Curse of Strahd · 4 people · $30 to pay', 'a game by its own name');
  assert.equal(finishedLine({ key: 'x', title: 'Quiet', rows: [] }), 'Quiet · no one booked');
});

test('a game’s title and its GM', () => {
  const [game, tables] = fixture().groups;
  assert.deepEqual(gameTitle(game), { name: 'Curse of Strahd', gm: 'Kate' });
  assert.deepEqual(gameTitle({ kind: 'game', title: 'Blades · in the Dark · GM Ana Silva' }), { name: 'Blades · in the Dark', gm: 'Ana Silva' });
  assert.deepEqual(gameTitle(tables), { name: 'Table bookings', gm: '' });
  assert.deepEqual(gameTitle({ kind: 'event', title: 'Meet the GM · GM night' }), { name: 'Meet the GM · GM night', gm: '' }, 'only a game has a GM');
  assert.deepEqual(gameTitle(null), { name: '', gm: '' });
});

test('every row gets a clear status badge: Here, Paid, Due $X, No-show or Refund?', () => {
  const today = fixture();
  const row = (id) => today.groups.flatMap((g) => g.rows).find((r) => r.id === id);
  assert.deepEqual(rowBadges(row('bk_ana')), [{ tone: 'warning', text: 'Due $30' }]);
  assert.deepEqual(rowBadges(row('bk_ana'), true), [{ tone: 'info', text: 'In cart' }]);
  assert.deepEqual(rowBadges(row('bk_ben')), [{ tone: 'success', text: 'Here' }]);
  assert.deepEqual(rowBadges(row('bk_cleo')), [{ tone: 'neutral', text: 'No-show' }]);
  assert.deepEqual(rowBadges(row('ej_rae')), [{ tone: 'critical', text: 'Refund?' }]);
  assert.deepEqual(rowBadges(row('bk_zoe')), [
    { tone: 'success', text: 'Here' },
    { tone: 'warning', text: 'Due $30' },
  ]);
  assert.deepEqual(rowBadges(row('bk_sam')), [
    { tone: 'warning', text: 'Due $45' },
    { tone: 'info', text: 'Pass' },
  ]);
  assert.deepEqual(rowBadges({ id: 1, paid: true, due: 0 }), [{ tone: 'success', text: 'Paid' }]);
  assert.deepEqual(rowBadges({ id: 1, paid: true, due: 0, pass }), [{ tone: 'success', text: 'Paid' }], 'no pass badge with nothing to pay');
  assert.deepEqual(rowBadges({ id: 1, due: 0 }), [{ tone: 'neutral', text: 'Free' }]);
  assert.equal(rowState({ id: 1, status: 'attended' }), 'arrived');
  assert.equal(rowState({ id: 1, status: 'confirmed', arrivedAt: 5 }), 'arrived');
  assert.equal(rowState({ id: 1, status: 'cancelled' }), 'cancelled');
});

test('people still to come are listed first', () => {
  const [game] = fixture().groups;
  assert.deepEqual(sortRows(game.rows).map((r) => r.id), ['bk_ana', 'bk_ben', 'bk_cleo']);
});

test('rows say who, how many, where and when', () => {
  const tables = fixture().groups[1];
  assert.equal(rowDetails(tables.rows[0]), '3 people · T4 · 7pm–10pm');
  assert.equal(rowDetails({ ...tables.rows[0], split: true }), '3 people · T4 · 7pm–10pm · Splitting the bill');
  assert.deepEqual(playerNames(fixture().groups[0].rows[2]), ['Ana (Grog)', 'Jo']);
  assert.deepEqual(playerNames({ id: 1, party: ['Sam', { name: 'Alex', character: '' }] }), ['Sam', 'Alex']);
  assert.equal(areYou(tables.rows[0]), 'Are you Sam?');
  assert.equal(areYou({ id: 1, name: '' }), 'Who is this?');
  assert.equal(whatLabel({ id: 1, type: 'booking', kind: 'gm-seat', title: 'Curse of Strahd' }), 'GM seat: Curse of Strahd');
  assert.equal(whatLabel({ id: 1, type: 'booking', kind: 'table', occurrenceId: 'ev@2026-10-03', title: 'Warhammer night' }), 'Game spot: Warhammer night');
  assert.equal(whatLabel({ id: 1, type: 'join', kind: 'join', title: 'Pokémon TCG league' }), 'Event entry: Pokémon TCG league');
  assert.equal(whatLabel({ id: 1, type: 'booking', kind: 'walkin', title: 'Table T2' }), 'Walk-in');
  assert.equal(whatLabel({ id: 1, type: 'booking', kind: 'table', title: 'Table T4' }), 'Table booking');
  assert.equal(rowKey({ id: 'ej_jo', type: 'join' }), 'join:ej_jo');
  assert.equal(rowKey({ id: 'bk_1' }), 'booking:bk_1');
});

test('search finds names without accents or case, players, and codes typed any way', () => {
  const today = fixture();
  const ids = (q) => searchToday(today, q).map((x) => x.row.id);
  assert.deepEqual(ids('zoe'), ['bk_zoe']);
  assert.deepEqual(ids('ZOË BERG'), ['bk_zoe']);
  assert.deepEqual(ids('sam'), ['bk_sam']);
  assert.deepEqual(ids('grog'), ['bk_ana']);
  assert.deepEqual(ids('owlbear 17'), ['bk_sam']);
  assert.deepEqual(ids('sj-owlbear-17'), ['bk_sam']);
  assert.deepEqual(ids('   '), []);
  assert.deepEqual(ids('nobody'), []);
  const jo = searchToday(today, 'jo');
  assert.deepEqual(
    jo.map((x) => x.row.id),
    ['ej_jo', 'bk_ana', 'bk_sam'],
    'still to come first (Jo Bloggs at 5pm, Ana with player Jo, Sam Jones), by time',
  );
  assert.equal(jo[0].group.title, 'Pokémon TCG league');
});

test('finds and refreshes rows after a check-in', () => {
  const today = fixture();
  assert.equal(findRow(today, 'ej_jo', 'join')?.group.key, 'event:ev_1@2026-10-03');
  assert.equal(findRow(today, 'ej_jo', 'booking'), null);
  const next = replaceRows(today, [{ id: 'bk_sam', type: 'booking', status: 'seated', arrivedAt: at(19), due: 1500 }]);
  const sam = findRow(next, 'bk_sam', 'booking')?.row;
  assert.equal(sam?.status, 'seated');
  assert.equal(sam?.due, 1500);
  assert.equal(sam?.name, 'Sam Jones', 'keeps the fields the answer left out');
  assert.equal(findRow(today, 'bk_sam', 'booking')?.row.status, 'confirmed', "doesn't change the old roster");
  assert.equal(replaceRows(null, []), null);
  const samRow = findRow(today, 'bk_sam', 'booking')?.row;
  const anaRow = findRow(today, 'bk_ana', 'booking')?.row;
  const merged = mergeRows([samRow, anaRow], [{ id: 'bk_ana', type: 'booking', status: 'seated' }, { id: 'ej_new', type: 'join', name: 'New' }]);
  assert.deepEqual(merged.map((r) => [r.id, r.status ?? null]), [['bk_sam', 'confirmed'], ['bk_ana', 'seated'], ['ej_new', null]], 'keeps the rest');
});

test('passes: what they say, and whether they can be used now', () => {
  assert.equal(passSummary(pass), 'Warhammer league · 7 left');
  assert.equal(passSummary({ code: 'X', sessionsLeft: 1 }), 'X · 1 left');
  assert.equal(passUsable({ code: 'SJ-KIWI-4', status: 'active', sessionsLeft: 2 }), true);
  assert.equal(passUsable({ code: 'SJ-KIWI-4', left: 7 }), true, 'a saved pass on a row has no status');
  assert.equal(passUsable({ code: 'SJ-KIWI-4', status: 'active', sessionsLeft: 0 }), false);
  assert.equal(passUsable({ code: 'SJ-KIWI-4', status: 'expired', sessionsLeft: 3 }), false);
  assert.equal(passUsable({ label: 'No code' }), false);
});

test('a pass can be used on table bookings, seats and game spots with something to pay, the holder’s first', () => {
  const today = fixture();
  // Sam is the holder's; Ana is still to come; Zoë is here but hasn't paid. Jo and Rae are event entries.
  assert.deepEqual(
    passCandidates(today, { code: 'P', holder: { customerId: 777 } }).map((x) => x.row.id),
    ['bk_sam', 'bk_ana', 'bk_zoe'],
  );
  assert.deepEqual(
    passCandidates(today, { code: 'P', holder: { customerId: '555' } }).map((x) => x.row.id),
    ['bk_ana', 'bk_sam', 'bk_zoe'],
  );
  assert.deepEqual(passCandidates(null, pass), []);
  // Never one whose fee (or a share of it) is in this sale: the pass would cover what the sale already charges.
  assert.deepEqual(passCandidates(today, { code: 'P' }, ['ZB-KEA-20']).map((x) => x.row.id), ['bk_ana', 'bk_sam']);
  // Nor one whose last share was just paid and hasn't reached the Lair app.
  assert.deepEqual(passCandidates(today, { code: 'P' }, [], ['AN-GOLEM-12']).map((x) => x.row.id), ['bk_sam', 'bk_zoe']);
});

test('a booking whose last share is on its way says so, and a named player’s own share is never held', () => {
  const zoe = { id: 'bk_zoe', type: 'booking', ref: 'ZB-KEA-20', name: 'Zoë van der Berg', people: 2, status: 'seated', arrivedAt: at(17), amount: 3000, paidAmount: 1500, due: 1500 };
  assert.equal(isHeld(zoe, ['ZB-KEA-20']), true);
  assert.equal(isHeld(zoe, []), false);
  assert.equal(isHeld({ ...zoe, id: 'bp_tama', playerOf: { name: 'Zoë' } }, ['ZB-KEA-20']), false, 'Tama’s own share: his to pay');
  assert.equal(isHeld({ ...zoe, ref: '' }, ['']), false);
  assert.deepEqual(rowBadges(zoe, false, true), [
    { tone: 'success', text: 'Here' },
    { tone: 'info', text: 'Payment on its way' },
  ]);
  assert.deepEqual(rowBadges(zoe, true, true)[1], { tone: 'info', text: 'In cart' }, 'in the cart wins');
  assert.deepEqual(rowBadges({ ...zoe, paidAmount: 3000, due: 0, paid: true }, false, true), [{ tone: 'success', text: 'Here' }], 'nothing left: no money badge');
});

test('the tile: people here of people booked, and a badge for those here with something to pay', () => {
  const entry = tileEntry(fixture(), 5000);
  // Zoë is the only one here who hasn't paid (Ben and the walk-in have).
  assert.deepEqual(entry, { at: 5000, day: '2026-10-03', people: 13, arrived: 5, owing: ['ZB-KEA-20'] });
  assert.deepEqual(tileWords(entry), { subheading: '5 of 13 here · 1 to pay', count: 1 });
  assert.deepEqual(tileWords(entry, ['ZB-KEA-20']), { subheading: '5 of 13 here', count: 0 }, 'her fee is in the cart');
  assert.deepEqual(tileWords(tileEntry({ groups: [] }, 1)), { subheading: 'Nothing booked today', count: 0 });
  assert.deepEqual(tileWords(null), { subheading: 'Nothing booked today', count: 0 });
});

test('the tile picks up newer numbers the check-in screen saved today', () => {
  const entry = tileEntry(fixture(), 5000);
  assert.deepEqual(newerTileEntry(entry, 1000, '2026-10-03'), entry);
  assert.equal(newerTileEntry(entry, 5000, '2026-10-03'), null, 'not newer than what the tile shows');
  assert.equal(newerTileEntry(entry, 1000, '2026-10-04'), null, "yesterday's numbers");
  assert.equal(newerTileEntry(undefined, 0, '2026-10-03'), null);
  assert.equal(newerTileEntry({ at: 9000, day: '2026-10-03', people: 3, arrived: 1 }, 0, '2026-10-03'), null, 'no owing list');
  assert.equal(newerTileEntry({ at: 'soon', day: '2026-10-03', people: 3, arrived: 1, owing: [] }, 0, '2026-10-03'), null);
  assert.equal(newerTileEntry({ at: 9000, day: '2026-10-03', text: '13 today · 5 here' }, 0, '2026-10-03'), null, 'the old tile words');
  assert.deepEqual(newerTileEntry({ at: 9000, day: '2026-10-03', people: 3, arrived: 1, owing: ['A', 7] }, 0, '2026-10-03')?.owing, ['A']);
});

test('a GM’s charge and an owed seat are only ever paid; a seat the GM pays for says so', () => {
  const charge = { id: 'bk_cv', type: 'booking', kind: 'gm-cover', ref: 'KA-OWL-12', name: 'Kate Moana', title: "Paying for Mia's seat: Curse of Strahd", status: 'confirmed', due: 1000 };
  assert.equal(isPayOnly(charge), true);
  assert.equal(isPayOnly({ id: 1, owed: true }), true);
  assert.equal(isPayOnly({ id: 1, kind: 'gm-seat' }), false);
  assert.equal(whatLabel(charge), "Paying for Mia's seat: Curse of Strahd");
  assert.equal(whatLabel({ ...charge, title: '' }), "Paying for a player's seat");
  const mia = { id: 'bk_mia', type: 'booking', kind: 'gm-seat', ref: 'MB-OTTER-9', name: 'Mia Brown', status: 'confirmed', amount: 0, due: 0, gmPays: { on: true, payer: 'Kate', amount: 1000 } };
  assert.equal(gmPaysFor(mia), true);
  assert.equal(gmPaysFor({ ...mia, gmPays: { can: true } }), false);
  assert.equal(gmPaysFor({ ...mia, kind: 'table' }), false);
  assert.deepEqual(rowBadges(mia), [{ tone: 'info', text: 'GM pays' }], 'not "Free"');
  assert.deepEqual(rowBadges({ ...mia, status: 'seated', arrivedAt: at(18) }), [
    { tone: 'success', text: 'Here' },
    { tone: 'info', text: 'GM pays' },
  ]);
  assert.deepEqual(rowBadges({ ...mia, gmPays: { can: true }, amount: 1500, due: 1500 }), [{ tone: 'warning', text: 'Due $15' }]);
});

test('“Kate pays for this seat” is offered on a GM game seat with something to pay and nothing paid on it', () => {
  const seat = { id: 'bk_mia', type: 'booking', kind: 'gm-seat', ref: 'MB-OTTER-9', name: 'Mia Brown', gameId: 'gm_1', status: 'confirmed', amount: 1500, due: 1500, paidAmount: 0 };
  // Before the Lair app sends gmPays: worked out from the seat; the Lair app says no, in words, if the GM can't.
  assert.equal(canGmPay(seat), true);
  assert.equal(canGmPay({ ...seat, status: 'seated', arrivedAt: at(18) }), true, 'here, not paid yet');
  assert.equal(canGmPay({ ...seat, paidAmount: 500, due: 1000 }), false, 'part paid');
  assert.equal(canGmPay({ ...seat, covered: 1500, due: 0 }), false, 'a pass took it off');
  assert.equal(canGmPay({ ...seat, due: 0, amount: 0 }), false, 'nothing to pay (a free session, or the GM pays already)');
  assert.equal(canGmPay({ ...seat, status: 'noshow' }), false);
  assert.equal(canGmPay({ ...seat, owed: true }), false, 'owed seats are the player’s');
  assert.equal(canGmPay({ ...seat, waived: true }), false);
  assert.equal(canGmPay({ ...seat, kind: 'table' }), false, 'only a GM game’s seat');
  // Once it sends gmPays, the Lair app decides.
  assert.equal(canGmPay({ ...seat, gmPays: { can: false } }), false);
  assert.equal(canGmPay({ ...seat, due: 0, gmPays: { can: true } }), true);
  assert.equal(canGmPay({ ...seat, gmPays: { can: true, on: true } }), false);
  // The charge this screen just set up, for a Lair app without gmPays.
  const covered = withCover({ ...seat, amount: 0, due: 0 }, { amount: 1000 }, 'Kate');
  assert.deepEqual(covered.gmPays, { on: true, can: false, payer: 'Kate', amount: 1000 });
  assert.equal(gmPaysFor(covered), true);
  assert.deepEqual(rowBadges(covered), [{ tone: 'info', text: 'GM pays' }]);
  assert.equal(withCover(seat, null, 'Kate'), seat);
  const told = { ...seat, gmPays: { on: true, payer: 'Kate', amount: 1000 } };
  assert.equal(withCover(told, { amount: 1000 }, 'Someone'), told, 'the Lair app’s word wins');
});

test('the GM-pays choice hides while the seat’s own fee is in the sale', () => {
  const seat = { id: 'bk_mia', type: 'booking', kind: 'gm-seat', ref: 'MB-OTTER-9', name: 'Mia Brown', gameId: 'gm_1', status: 'confirmed', amount: 1500, due: 1500, paidAmount: 0 };
  assert.equal(gmPaysChoice(seat, false), 'offer');
  assert.equal(gmPaysChoice(seat, true), 'in-cart', 'paying the line would end the offer; the GM’s charge on top would take too much');
  const paying = withCover({ ...seat, amount: 0, due: 0 }, { amount: 1000 }, 'Kate');
  assert.equal(gmPaysChoice(paying, false), 'stop');
  assert.equal(gmPaysChoice(paying, true), 'in-cart');
  assert.equal(gmPaysChoice({ ...seat, paidAmount: 500, due: 1000 }, false), null, 'part paid: nothing to offer');
  assert.equal(gmPaysChoice({ ...seat, paidAmount: 500, due: 1000 }, true), null);
  assert.equal(gmPaysChoice({ ...seat, kind: 'table' }, false), null);
  assert.equal(gmPaysChoice(null, false), null);
});

// 1 and 2 Oct 2026 are NZDT too. (Dates in October only: some ICU versions shorten September to "Sept".)
const oct1 = (hourNz) => Date.UTC(2026, 9, 1, hourNz - 13, 0);
const oct2 = (hourNz) => Date.UTC(2026, 9, 2, hourNz - 13, 0);
const regular = {
  id: 'bk_kai',
  type: 'booking',
  kind: 'gm-seat',
  ref: 'KT-KRAKEN-7',
  name: 'Kai Tane',
  people: 1,
  start: at(18),
  end: at(22),
  status: 'confirmed',
  due: 1500,
  customerId: '888',
  seriesId: 'sr_strahd',
  owed: false,
  title: 'Curse of Strahd',
};

test('a weekly regular\'s seat says Weekly, after the usual badges', () => {
  assert.deepEqual(rowBadges(regular), [
    { tone: 'warning', text: 'Due $15' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges({ ...regular, status: 'seated', arrivedAt: at(18), due: 0, paid: true }), [
    { tone: 'success', text: 'Here' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges(regular, true), [
    { tone: 'info', text: 'In cart' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges({ ...regular, seriesId: null }), [{ tone: 'warning', text: 'Due $15' }], 'a one-off seat');
});

test('an owed session says Owed $X, even for a no-show, never Pass, and when it was', () => {
  const owed = { ...regular, owed: true, start: oct1(18), end: oct1(21), pass };
  assert.equal(isOwed(owed), true);
  assert.equal(isOwed({ ...owed, due: 0 }), false, 'paid or waived since');
  assert.equal(isOwed(regular), false);
  assert.deepEqual(rowBadges(owed), [
    { tone: 'warning', text: 'Owed $15' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges({ ...owed, status: 'noshow' }), [
    { tone: 'neutral', text: 'No-show' },
    { tone: 'warning', text: 'Owed $15' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges({ ...owed, status: 'seated', arrivedAt: oct1(18) }), [
    { tone: 'success', text: 'Here' },
    { tone: 'warning', text: 'Owed $15' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.deepEqual(rowBadges({ ...regular, status: 'noshow' }), [
    { tone: 'neutral', text: 'No-show' },
    { tone: 'info', text: 'Weekly' },
  ]);
  assert.equal(owedWhen(owed), 'Thu 1 Oct, 6pm–9pm');
  assert.equal(owedWhen({ ...owed, start: oct2(19), end: oct2(22) }), 'Fri 2 Oct, 7pm–10pm');
  assert.equal(owedWhen({ ...owed, start: at(18), end: at(22) }), 'Sat 3 Oct, 6pm–10pm', 'the date even for today');
});

test('an owed no-show still counts as money due; owed seats are never offered a pass', () => {
  const owedNoShow = { ...regular, status: 'noshow', owed: true };
  assert.deepEqual(countRows([owedNoShow]), { people: 1, arrived: 0, due: 1500 });
  assert.deepEqual(countRows([{ ...regular, status: 'noshow' }]), { people: 1, arrived: 0, due: 0 });
  const today = {
    groups: [
      {
        key: 'game:gm_9',
        kind: 'game',
        title: 'Curse of Strahd · GM Kate',
        start: at(12),
        end: at(15),
        rows: [
          { ...regular, owed: true, start: at(12), end: at(15) },
          { ...regular, id: 'bk_one', ref: 'ON-OGRE-2', seriesId: null, start: at(12), end: at(15) },
        ],
      },
    ],
  };
  assert.deepEqual(
    passCandidates(today, pass).map((x) => x.row.id),
    ['bk_one'],
  );
});

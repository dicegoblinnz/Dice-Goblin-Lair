// The Today roster: grouping, counts, badges, search and passes: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areYou,
  countRows,
  findRow,
  groupDetails,
  groupSummary,
  mergeRows,
  newerTileText,
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
  tileSubheading,
  whatLabel,
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
  assert.equal(groupSummary(game), '1/4 here · $30 due');
  assert.equal(groupSummary(tables), '2/5 here · $45 due');
  // Zoë is here but hasn't paid yet; Rae paid and didn't come (a refund to sort out, not money due).
  assert.equal(groupSummary(event), '2/4 here · $40 due');
  assert.equal(groupSummary({ key: 'x', rows: [] }), 'No one booked yet');
  assert.deepEqual(countRows(tables.rows), { people: 5, arrived: 2, due: 4500 });
  assert.equal(groupDetails(game), '6pm–10pm · T7, T8');
  assert.equal(groupDetails(tables), '2 bookings');
  assert.equal(tileSubheading(fixture()), '13 today · 5 here');
  assert.equal(tileSubheading({ groups: [] }), 'Nothing booked today');
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
});

test('the tile picks up newer numbers the check-in screen saved today', () => {
  const entry = tileEntry(fixture(), 5000);
  assert.deepEqual(entry, { at: 5000, day: '2026-10-03', text: '13 today · 5 here' });
  assert.equal(newerTileText(entry, 1000, '2026-10-03'), '13 today · 5 here');
  assert.equal(newerTileText(entry, 5000, '2026-10-03'), null, 'not newer than what the tile shows');
  assert.equal(newerTileText(entry, 1000, '2026-10-04'), null, "yesterday's numbers");
  assert.equal(newerTileText(undefined, 0, '2026-10-03'), null);
  assert.equal(newerTileText({ at: 9000, day: '2026-10-03' }, 0, '2026-10-03'), null);
  assert.equal(newerTileText({ at: 'soon', day: '2026-10-03', text: 'x' }, 0, '2026-10-03'), null);
});

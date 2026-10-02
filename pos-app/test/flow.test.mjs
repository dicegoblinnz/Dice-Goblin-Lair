// Which screen comes next and what each screen offers: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkinOutcome,
  codeInQuery,
  currentRow,
  HOME,
  memberPlan,
  nextScreen,
  NO_PASS,
  notALairCode,
  passOptions,
  passParam,
  personPlan,
  personScreen,
  scanPurpose,
  stackAfterPerson,
  tabPlan,
  wrongScan,
} from '../extensions/lair-checkin/src/flow.js';

// 3 Oct 2026 is NZDT (UTC+13).
const at = (day, hourNz) => Date.UTC(2026, 9, day, hourNz - 13, 0);
const TODAY = '2026-10-03';

const kiwi = { code: 'SJ-KIWI-4', label: 'Warhammer league', left: 7 };
const row = { id: 'bk_sam', type: 'booking', ref: 'SJ-OWLBEAR-17', name: 'Sam Jones', people: 3, tables: ['T4'], start: at(3, 19), end: at(3, 22), status: 'confirmed', amount: 4500, covered: 0, due: 4500, customerId: '777', pass: null };

test('a booking or sign-up opens the person view, with the pass choice ready', () => {
  const screen = nextScreen({ type: 'booking', row, group: { key: 'tables', kind: 'tables', title: 'Table bookings', start: 1 } });
  assert.deepEqual(screen, {
    name: 'person',
    row: { ...row, type: 'booking' },
    groupKey: 'tables',
    groupTitle: 'Table bookings',
    passes: [],
    choice: null,
    result: null,
    split: { open: false, mode: 'person', custom: '', payer: null },
  });
  const join = nextScreen({ type: 'join', row: { id: 'ej_1', ref: 'JO-PIXIE-1' }, group: null });
  assert.equal(join?.name === 'person' && join.row.type, 'join');
  assert.equal(join?.name === 'person' && join.groupKey, null);
  assert.equal(personScreen({ ...row, pass: kiwi }).choice, 'SJ-KIWI-4', 'the saved pass starts picked');
});

test('a member opens the member view with their rows, tab and passes', () => {
  const screen = nextScreen({
    type: 'member',
    member: { customerId: '777', name: 'Sam Jones', code: 'SJ-BADGER-2' },
    rows: [row],
    tab: { id: 'tab_1', items: [] },
    passes: [{ code: 'SJ-KIWI-4' }],
  });
  assert.equal(screen?.name, 'member');
  if (screen?.name !== 'member') return;
  assert.equal(screen.member.name, 'Sam Jones');
  assert.equal(screen.rows.length, 1);
  assert.equal(screen.tab?.id, 'tab_1');
  assert.equal(screen.passes.length, 1);
  assert.deepEqual(screen.notices, []);
  const bare = nextScreen({ type: 'member', member: { customerId: '1' } });
  assert.deepEqual(bare?.name === 'member' && [bare.rows, bare.tab, bare.passes], [[], null, []]);
});

test('a pass opens the pass view; anything else is not a screen', () => {
  assert.deepEqual(nextScreen({ type: 'pass', pass: { code: 'SJ-KIWI-4' } }), { name: 'pass', pass: { code: 'SJ-KIWI-4' }, picking: false });
  assert.equal(nextScreen({ type: 'pass' }), null);
  assert.equal(nextScreen({ type: 'booking' }), null);
  assert.equal(nextScreen({ type: 'mystery' }), null);
  assert.equal(nextScreen(null), null);
});

test('after the cart: back to the member, else to the person’s group, else one step back', () => {
  const person = personScreen(row, { groupKey: 'tables' });
  const member = /** @type {const} */ ({ name: 'member', member: {}, rows: [], tab: null, passes: [], notices: [] });
  const known = () => true;
  const unknown = () => false;
  assert.deepEqual(stackAfterPerson([HOME, member, person], 'tables', known), [HOME, member]);
  assert.deepEqual(stackAfterPerson([HOME, person], 'tables', known), [HOME, { name: 'group', key: 'tables' }]);
  assert.deepEqual(stackAfterPerson([HOME, { name: 'group', key: 'game:1' }, person], 'game:1', known), [HOME, { name: 'group', key: 'game:1' }]);
  assert.deepEqual(stackAfterPerson([HOME, { name: 'pass', pass: {}, picking: true }, person], 'tables', known), [HOME, { name: 'group', key: 'tables' }]);
  assert.deepEqual(stackAfterPerson([HOME, person], 'tables', unknown), [HOME]);
  assert.deepEqual(stackAfterPerson([HOME, person], null, known), [HOME]);
  assert.deepEqual(stackAfterPerson([person], null, known), [HOME]);
});

test('the person view shows the freshest copy of its row', () => {
  const screen = personScreen(row);
  const today = { groups: [{ key: 'tables', rows: [{ ...row, status: 'seated', arrivedAt: 5 }] }] };
  assert.equal(currentRow(screen, today).status, 'seated');
  assert.equal(currentRow(screen, { groups: [] }).status, 'confirmed');
  const checked = { ...screen, result: { row: { ...row, status: 'seated', arrivedAt: 6, due: 1500 } } };
  assert.equal(currentRow(checked, null).due, 1500, 'another day’s booking only has the check-in answer');
});

test('before check-in: the saved pass, the member’s other passes, or no pass', () => {
  const members = [
    { code: 'sj-kiwi-4', label: 'Warhammer league', sessionsLeft: 7, status: 'active' },
    { code: 'SJ-MOA-8', label: 'Gift pack', sessionsLeft: 3, status: 'active' },
    { code: 'SJ-TUI-1', label: 'Old pack', sessionsLeft: 0, status: 'used' },
  ];
  assert.deepEqual(passOptions({ ...row, pass: kiwi }, members), {
    options: [
      { value: 'SJ-KIWI-4', label: 'Warhammer league · 7 left (saved on the booking)' },
      { value: 'SJ-MOA-8', label: 'Gift pack · 3 left' },
      { value: NO_PASS, label: "Don't use a pass" },
    ],
    picked: 'SJ-KIWI-4',
  });
  assert.deepEqual(passOptions(row, members).picked, NO_PASS, 'no saved pass: nothing is used unless staff pick one');
  assert.deepEqual(passOptions(row, []), { options: [], picked: null });
  assert.deepEqual(passOptions({ ...row, type: 'join' }, members), { options: [], picked: null }, 'passes never cover event entry');
  assert.deepEqual(passOptions({ ...row, pass: { ...kiwi, left: 0 } }, []), { options: [], picked: null }, 'a used-up saved pass is not offered');
  // What each choice sends.
  const saved = { ...row, pass: kiwi };
  assert.equal(passParam('SJ-KIWI-4', saved), undefined, 'the saved pass: left out, so the Lair app uses the booking’s own');
  assert.equal(passParam('sj kiwi 4', saved), undefined);
  assert.equal(passParam('SJ-MOA-8', saved), 'SJ-MOA-8');
  assert.equal(passParam(NO_PASS, saved), 'none');
  assert.equal(passParam(null, row), undefined);
});

test('once they’re here: only a pass for what’s left, and asking again never uses one by itself', () => {
  const here = { ...row, status: 'seated', arrivedAt: at(3, 19), pass: kiwi, covered: 3000, due: 1500 };
  const members = [{ code: 'SJ-MOA-8', label: 'Gift pack', sessionsLeft: 3, status: 'active' }, { code: 'SJ-KIWI-4', label: 'Warhammer league', sessionsLeft: 4, status: 'active' }];
  assert.deepEqual(passOptions(here, members), { options: [{ value: 'SJ-MOA-8', label: 'Gift pack · 3 left' }], picked: null });
  assert.deepEqual(passOptions({ ...here, due: 0 }, members), { options: [], picked: null });
  assert.deepEqual(passOptions({ ...here, covered: 0, due: 4500 }, []).options.map((o) => o.value), ['SJ-KIWI-4'], 'saved but not used yet');
  assert.equal(passParam(null, here), 'none');
  assert.equal(passParam('SJ-MOA-8', here), 'SJ-MOA-8');
});

test('what a check-in answer means', () => {
  const line = { title: 'Table fee: SJ-OWLBEAR-17 (T4, 3 people) (pass covered $30)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17' } };
  const paying = checkinOutcome({
    row: { ...row, status: 'seated', arrivedAt: 1, covered: 3000, due: 1500 },
    lines: [line],
    customer: { id: '777' },
    pass: { code: 'SJ-KIWI-4', label: 'Warhammer league', used: 3, left: 4, covered: 3000 },
    notice: null,
  });
  assert.equal(paying.arrived, true);
  assert.equal(paying.total, 1500);
  assert.equal(paying.text, 'Checked in. $15 to pay.');
  assert.equal(paying.passText, 'Warhammer league covered $30 · 4 sessions left');
  const free = checkinOutcome({ row: { ...row, status: 'seated', arrivedAt: 1, due: 0, paid: true }, lines: [], pass: null, notice: null });
  assert.equal(free.text, 'Checked in. Nothing to pay.');
  const refused = checkinOutcome({ checkedIn: false, row: { ...row, start: at(4, 19) }, lines: [], notice: 'This booking is for Sunday 4 October, not today: Sam Jones, 3 people at T4.' });
  assert.deepEqual([refused.arrived, refused.refused], [false, 'This booking is for Sunday 4 October, not today: Sam Jones, 3 people at T4.']);
  assert.equal(checkinOutcome({ row, lines: [] }).arrived, false, 'no checkedIn field: the row says');
});

test('the person view: check in, check in anyway, pay, or done', () => {
  assert.deepEqual(personPlan(row, null, TODAY), { stage: 'check-in', force: false, warning: '' });
  assert.deepEqual(personPlan({ ...row, start: at(4, 19), end: at(4, 22) }, null, TODAY), {
    stage: 'check-in',
    force: true,
    warning: 'This booking is for Sun 4 Oct, 7pm–10pm, not today.',
  });
  assert.equal(personPlan({ ...row, status: 'noshow' }, null, TODAY).warning, 'This booking was marked as a no-show.');
  assert.equal(personPlan({ ...row, type: 'join', status: 'cancelled' }, null, TODAY).warning, 'This sign-up was cancelled.');
  assert.deepEqual(personPlan(row, { checkedIn: false, row, notice: 'Not today, friend.' }, TODAY), { stage: 'check-in', force: true, warning: 'Not today, friend.' });
  assert.equal(personPlan({ ...row, status: 'seated', arrivedAt: 1 }, null, TODAY).stage, 'pay');
  assert.equal(personPlan({ ...row, status: 'seated', arrivedAt: 1, due: 0 }, null, TODAY).stage, 'done');
});

test('a scanned code goes where staff expect', () => {
  const on = (screen, extra = {}) => ({ want: /** @type {const} */ ('any'), screen, splitOpen: false, takesPass: false, ...extra });
  assert.equal(scanPurpose(on('home'), 'member'), 'open');
  assert.equal(scanPurpose(on('person', { splitOpen: true }), 'member'), 'payer', 'splitting: a member code says who pays');
  assert.equal(scanPurpose(on('person', { splitOpen: true }), 'booking'), 'open');
  assert.equal(scanPurpose(on('person', { takesPass: true }), 'pass'), 'pass', 'a pass becomes a choice for this booking');
  assert.equal(scanPurpose(on('person'), 'pass'), 'open');
  assert.equal(scanPurpose(on('group'), 'pass'), 'open');
  assert.equal(scanPurpose(on('person', { want: 'payer' }), 'member'), 'payer');
  assert.equal(scanPurpose(on('person', { want: 'payer' }), 'pass'), 'wrong');
  assert.equal(scanPurpose(on('person', { want: 'pass' }), 'member'), 'wrong');
  assert.equal(wrongScan('pass').title, "That's not a pass code");
  assert.equal(wrongScan('payer').title, "That's not a member code");
  assert.deepEqual(notALairCode('9421234567890'), {
    title: "That's not a Lair code",
    message: '"9421234567890" isn\'t a booking, member or pass code. They look like SJ-OWLBEAR-17.',
  });
  assert.equal(codeInQuery('sj owlbear 17'), 'SJ-OWLBEAR-17');
  assert.equal(codeInQuery('gob7k2qxm'), 'GOB-7K2QXM');
  assert.equal(codeInQuery('Sam'), null);
});

test('the member view: check in everyone while anyone is still to come or still owes', () => {
  assert.deepEqual(memberPlan([row]), { canCheckIn: true, waiting: 1, due: 4500 });
  assert.deepEqual(memberPlan([{ ...row, status: 'seated', arrivedAt: 1, due: 0 }]), { canCheckIn: false, waiting: 0, due: 0 });
  assert.deepEqual(memberPlan([{ ...row, status: 'seated', arrivedAt: 1, due: 1500 }]), { canCheckIn: true, waiting: 0, due: 1500 });
  assert.deepEqual(memberPlan([{ ...row, status: 'noshow' }]), { canCheckIn: false, waiting: 0, due: 0 });
  assert.deepEqual(memberPlan([]), { canCheckIn: false, waiting: 0, due: 0 });
});

test('the member view: their tab', () => {
  const tab = { id: 'tab_1', status: 'open', items: [{ variantId: '1', title: 'Coke', qty: 2, price: 350 }], total: 700 };
  assert.deepEqual(tabPlan(tab, []), { show: true, canAdd: true, note: '' });
  assert.equal(tabPlan(tab, ['tab_1']).canAdd, false, 'already in this cart');
  assert.equal(tabPlan({ ...tab, status: 'paid' }, []).note, 'Paid');
  assert.equal(tabPlan({ ...tab, status: 'in-cart' }, []).canAdd, true, 'a sale that never went through');
  assert.equal(tabPlan({ ...tab, items: [] }, []).canAdd, false);
  assert.equal(tabPlan(null, []).show, false);
});

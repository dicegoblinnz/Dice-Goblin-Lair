// Which screen comes next and what each screen offers: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterCart,
  CLOSES,
  checkinOutcome,
  codeInQuery,
  currentRow,
  everythingOutcome,
  everythingPlan,
  failedFeesText,
  groupPlan,
  groupScreen,
  HOME,
  memberPlan,
  personAction,
  whyNothing,
  nextScreen,
  NO_PASS,
  notALairCode,
  openUseIds,
  passChange,
  passInUse,
  passOptions,
  passParam,
  passProblem,
  personPlan,
  personScreen,
  recordUses,
  scanPurpose,
  splitOwed,
  stackAfterPerson,
  tabNotes,
  tabPlan,
  undoNote,
  withGroups,
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
    uses: [],
    note: null,
    loyalty: null,
    filled: false,
    cover: null,
    confirm: null,
  });
  const card = { stamps: 9, cardSize: 10, rollsAvailable: 0, card: 2 };
  const withCard = nextScreen({ type: 'booking', row, group: null, loyalty: card });
  assert.deepEqual(withCard?.name === 'person' && withCard.loyalty, card, 'their card, once the Lair app sends it with tickets');
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
    loyalty: { stamps: 7, cardSize: 10, rollsAvailable: 1 },
  });
  assert.equal(screen?.name, 'member');
  if (screen?.name !== 'member') return;
  assert.equal(screen.member.name, 'Sam Jones');
  assert.equal(screen.rows.length, 1);
  assert.equal(screen.tab?.id, 'tab_1');
  assert.equal(screen.passes.length, 1);
  assert.deepEqual(screen.notices, []);
  assert.deepEqual(screen.loyalty, { stamps: 7, cardSize: 10, rollsAvailable: 1 }, 'the loyalty card, for show (round 6)');
  const bare = nextScreen({ type: 'member', member: { customerId: '1' } });
  assert.deepEqual(bare?.name === 'member' && [bare.rows, bare.tab, bare.passes, bare.loyalty], [[], null, [], null]);
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
  const group = (key) => ({ name: 'group', key, ticked: [], picking: false });
  assert.deepEqual(stackAfterPerson([HOME, member, person], 'tables', known), [HOME, member]);
  assert.deepEqual(stackAfterPerson([HOME, person], 'tables', known), [HOME, group('tables')]);
  assert.deepEqual(stackAfterPerson([HOME, { name: 'group', key: 'game:1', ticked: ['booking:x'], picking: true }, person], 'game:1', known), [HOME, group('game:1')]);
  assert.deepEqual(stackAfterPerson([HOME, { name: 'pass', pass: {}, picking: true }, person], 'tables', known), [HOME, group('tables')]);
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

test('once they’re here with a pass in use: keep it, switch it, or use none', () => {
  const here = { ...row, status: 'seated', arrivedAt: at(3, 19), pass: kiwi, covered: 3000, due: 1500 };
  const members = [{ code: 'SJ-MOA-8', label: 'Gift pack', sessionsLeft: 3, status: 'active' }, { code: 'SJ-KIWI-4', label: 'Warhammer league', sessionsLeft: 4, status: 'active' }];
  // Checked in earlier: the booking's own pass is the one in use.
  const inUse = passInUse(here, []);
  assert.deepEqual(inUse, { code: 'SJ-KIWI-4', label: 'Warhammer league', left: 7 });
  assert.deepEqual(passOptions(here, members, inUse), {
    options: [
      { value: 'SJ-KIWI-4', label: 'Warhammer league · 7 left (in use)' },
      { value: 'SJ-MOA-8', label: 'Gift pack · 3 left' },
      { value: NO_PASS, label: "Don't use a pass" },
    ],
    picked: 'SJ-KIWI-4',
  });
  assert.equal(passOptions({ ...here, due: 0 }, members, inUse).picked, 'SJ-KIWI-4', 'covered in full: still switchable');
  assert.deepEqual(passChange(inUse, 'SJ-KIWI-4'), { action: 'none', pass: '', label: '' });
  assert.deepEqual(passChange(inUse, 'sj moa 8'), { action: 'switch', pass: 'sj moa 8', label: 'Switch to this pass' });
  assert.deepEqual(passChange(inUse, NO_PASS), { action: 'switch', pass: NO_PASS, label: 'Check in again without a pass' });
  assert.equal(passParam('SJ-MOA-8', here), 'SJ-MOA-8');
  assert.equal(passParam(NO_PASS, here), 'none');
});

test('once they’re here with no pass in use: only a pass for what’s left, and asking again never uses one by itself', () => {
  const here = { ...row, status: 'seated', arrivedAt: at(3, 19), pass: kiwi, covered: 0, due: 4500 };
  const members = [{ code: 'SJ-MOA-8', label: 'Gift pack', sessionsLeft: 3, status: 'active' }];
  assert.equal(passInUse(here, []), null);
  assert.deepEqual(passOptions(here, members, null), {
    options: [
      { value: 'SJ-KIWI-4', label: 'Warhammer league · 7 left (saved on the booking)' },
      { value: 'SJ-MOA-8', label: 'Gift pack · 3 left' },
    ],
    picked: null,
  });
  assert.deepEqual(passOptions({ ...here, due: 0 }, members, null), { options: [], picked: null });
  assert.deepEqual(passChange(null, 'SJ-MOA-8'), { action: 'use', pass: 'SJ-MOA-8', label: 'Use this pass' });
  assert.deepEqual(passChange(null, NO_PASS), { action: 'none', pass: '', label: '' });
  assert.deepEqual(passChange(null, null), { action: 'none', pass: '', label: '' });
  assert.equal(passParam(null, here), 'none');
});

test('remembers the pass uses it sees, so they can be undone', () => {
  const answer = { row, pass: { code: 'SJ-KIWI-4', label: 'Warhammer league', used: 3, left: 4, covered: 3000, useId: 'pu_1' } };
  const uses = recordUses([], answer);
  assert.deepEqual(uses, [{ useId: 'pu_1', code: 'SJ-KIWI-4', label: 'Warhammer league', covered: 3000, used: 3, left: 4 }]);
  assert.equal(recordUses(uses, answer), uses, 'the same use once');
  assert.equal(recordUses(uses, { row, pass: null }), uses);
  assert.equal(recordUses(uses, { row, pass: { code: 'X' } }), uses, 'no useId (an older Lair app)');
  const second = recordUses(uses, { pass: { code: 'SJ-MOA-8', label: 'Gift pack', used: 1, left: 2, covered: 1000, useId: 'pu_2' } });
  assert.deepEqual(second.map((u) => u.useId), ['pu_1', 'pu_2']);
  // The last one used is the one in use.
  assert.deepEqual(passInUse({ ...row, covered: 4000 }, second), { code: 'SJ-MOA-8', label: 'Gift pack', left: 2 });
  assert.equal(passInUse({ ...row, covered: 0 }, second), null, 'nothing covered: undone elsewhere');
  // A check-in that used a pass opens the person view with that use known.
  const screen = personScreen(row, { result: { ...answer, row: { ...row, status: 'seated', arrivedAt: 1, covered: 3000, due: 1500 } } });
  assert.deepEqual(screen.uses.map((u) => u.useId), ['pu_1']);
  assert.equal(screen.choice, 'SJ-KIWI-4', 'the pass in use starts picked');
});

test('finds a booking’s pass uses from the pass itself, and says what undoing did', () => {
  const pass = {
    code: 'SJ-KIWI-4',
    label: 'Warhammer league',
    sessionsLeft: 7,
    uses: [
      { id: 'pu_1', bookingId: 'bk_sam', ref: 'SJ-OWLBEAR-17', people: 3, covered: 3000, at: 1, undone: null },
      { id: 'pu_0', bookingId: 'bk_sam', ref: 'SJ-OWLBEAR-17', people: 1, covered: 1000, at: 0, undone: 5 },
      { id: 'pu_9', bookingId: 'bk_ana', ref: 'AS-GOLEM-12', people: 1, covered: 1000, at: 2, undone: null },
    ],
  };
  assert.deepEqual(openUseIds(pass, 'bk_sam'), ['pu_1']);
  assert.deepEqual(openUseIds({ code: 'X' }, 'bk_sam'), []);
  assert.deepEqual(undoNote([{ pass, row: { ...row, covered: 0, due: 4500 } }], { ...row, covered: 0, due: 4500 }), {
    heading: 'Pass undone. $45 to pay.',
    body: 'Warhammer league has 7 sessions left.',
  });
  assert.deepEqual(undoNote([{ pass: { code: 'P', label: 'Gift pack' }, row: null }], { ...row, due: 0, paid: true }), {
    heading: 'Pass undone. Nothing to pay.',
    body: 'The session is back on Gift pack.',
  });
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
  assert.equal(passProblem({ code: 'P', status: 'active', sessionsLeft: 2 }), '');
  assert.equal(passProblem({ code: 'P', status: 'void', sessionsLeft: 2 }), 'It was cancelled on the staff page.');
  assert.equal(passProblem({ code: 'P', status: 'expired', sessionsLeft: 2, expiresAt: Date.UTC(2026, 11, 31, 10) }), 'It expired on 31 Dec 2026.');
  assert.equal(passProblem({ code: 'P', status: 'used', sessionsLeft: 0 }), 'It has no sessions left.');
  assert.equal(codeInQuery('sj owlbear 17'), 'SJ-OWLBEAR-17');
  assert.equal(codeInQuery('gob7k2qxm'), 'GOB-7K2QXM');
  assert.equal(codeInQuery('Sam'), null);
});

test('the member view: check in everyone while anyone is still to come, else add what they owe', () => {
  const here = { ...row, status: 'seated', arrivedAt: 1, due: 1500 };
  assert.deepEqual(memberPlan([row]), { canCheckIn: true, waiting: 1, due: 4500, coming: [row], owing: [] });
  assert.deepEqual(memberPlan([{ ...here, due: 0 }]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
  assert.deepEqual(memberPlan([here]), { canCheckIn: true, waiting: 0, due: 1500, coming: [], owing: [here] });
  assert.deepEqual(memberPlan([here], ['SJ-OWLBEAR-17']), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] }, 'already in the cart');
  assert.deepEqual(memberPlan([{ ...row, status: 'noshow' }]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
  assert.deepEqual(memberPlan([]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
  const today = { groups: [{ key: 'tables', title: 'Table bookings', rows: [here] }] };
  assert.deepEqual(withGroups([row, { id: 'x', type: 'join' }], today).map((x) => [x.row.status, x.group?.key ?? null]), [
    ['seated', 'tables'],
    [undefined, null],
  ]);
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

/* ---------------- round 5: owed sessions, weekly regulars and one bill ---------------- */

// Kai, a weekly regular: tonight's seat, and last Thursday's that ended unpaid (owed, with the Lair app's line).
const tonight = { id: 'bk_tonight', type: 'booking', kind: 'gm-seat', ref: 'KT-OGRE-2', name: 'Kai Tane', people: 1, start: at(3, 18), end: at(3, 22), status: 'confirmed', due: 1500, customerId: '888', seriesId: 'sr_strahd', owed: false, title: 'Curse of Strahd' };
const owedLine = { title: 'Owed: Curse of Strahd (Thu 1 Oct)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'KT-KRAKEN-7' } };
const lastWeek = { ...tonight, id: 'bk_last', ref: 'KT-KRAKEN-7', start: Date.UTC(2026, 9, 1, 5), end: Date.UTC(2026, 9, 1, 9), status: 'noshow', owed: true, line: owedLine };
const kaiTab = { id: 'tab_kai', status: 'open', items: [{ variantId: '1', title: 'Coke', qty: 2, price: 350 }], total: 700 };

test('owed sessions are kept apart from today\'s rows, and the Today button leaves them out', () => {
  assert.deepEqual(splitOwed([tonight, lastWeek]), { today: [tonight], owed: [lastWeek] });
  assert.deepEqual(memberPlan([tonight, lastWeek]), { canCheckIn: true, waiting: 1, due: 1500, coming: [tonight], owing: [] });
  assert.deepEqual(memberPlan([lastWeek]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
  // Owed whether or not they came, and whether or not anyone marked them: never one to check in or ask lines for.
  assert.deepEqual(memberPlan([{ ...lastWeek, status: 'confirmed' }]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
  assert.deepEqual(memberPlan([{ ...lastWeek, status: 'seated', arrivedAt: 1 }]), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] });
});

test('an owed session on the person view is paid, never checked in, whatever its day', () => {
  assert.deepEqual(personPlan(lastWeek, null, TODAY), { stage: 'owed', force: false, warning: '' });
  assert.deepEqual(personPlan({ ...lastWeek, status: 'seated', arrivedAt: 1 }, null, TODAY), { stage: 'owed', force: false, warning: '' });
  assert.equal(personPlan({ ...lastWeek, due: 0, paid: true }, null, TODAY).stage, 'paid', 'paid since: nothing to do, never a check-in');
  assert.equal(personPlan(tonight, null, TODAY).stage, 'check-in');
});

test('Add everything to cart: today\'s fees, owed sessions and the tab in one button, broken down when it\'s more than one', () => {
  const plan = everythingPlan([tonight, lastWeek], kaiTab);
  assert.deepEqual(
    [plan.show, plan.label, plan.total, plan.separate, plan.parts, plan.note, plan.tab, plan.tabTotal, plan.owedDue],
    [true, 'Check in and add everything · $37', 3700, true, 'Today $15 · Owed $15 · Tab $7', '', true, 700, 1500],
  );
  assert.deepEqual(plan.owed, [lastWeek]);
  assert.deepEqual(plan.today, { canCheckIn: true, waiting: 1, due: 1500, coming: [tonight], owing: [] });
  // What's in the cart already doesn't count again.
  const inCart = everythingPlan([tonight, lastWeek], kaiTab, { bookings: ['KT-KRAKEN-7'], tabs: ['tab_kai'] });
  assert.deepEqual([inCart.label, inCart.separate, inCart.parts, inCart.owed], ['Check in and add $15 to cart', false, '', []]);
  // One part only: no breakdown, and no "everything".
  assert.deepEqual([everythingPlan([lastWeek], null).label, everythingPlan([lastWeek], null).separate], ['Add $15 to cart', false]);
  assert.deepEqual([everythingPlan([], kaiTab).label, everythingPlan([], kaiTab).separate], ['Add $7 to cart', false]);
  // Nobody to check in, more than one part.
  assert.equal(everythingPlan([lastWeek], kaiTab).label, 'Add everything to cart · $22');
  // A tab with no prices: say whether they're checked in too.
  const unpriced = { id: 'tab_3', items: [{ variantId: '1', title: 'Coke', qty: 1 }] };
  assert.equal(everythingPlan([{ ...tonight, due: 0, amount: 0 }], unpriced).label, 'Check in and add the tab');
  // A saved pass comes off at check-in, so the cart may come to less.
  assert.equal(everythingPlan([{ ...row, pass: kiwi }, lastWeek], null).note, 'A saved pass comes off when they check in, so it may come to less.');
  assert.equal(everythingPlan([{ ...row, pass: { ...kiwi, left: 0 } }], null).note, '', 'a used-up pass takes nothing off');
  // Nothing to pay, but someone to check in; a tab with no prices; nothing at all.
  const free = { ...row, due: 0, amount: 0 };
  assert.deepEqual([everythingPlan([free], null).show, everythingPlan([free], null).label], [true, 'Check in everyone']);
  assert.deepEqual(everythingPlan([], { id: 'tab_2', items: [{ variantId: '1', title: 'Coke', qty: 1 }] }).label, 'Add the tab to cart');
  const nothing = everythingPlan([{ ...row, status: 'seated', arrivedAt: 1, due: 0 }, { ...lastWeek, due: 0, paid: true }], { ...kaiTab, status: 'paid' });
  assert.deepEqual([nothing.show, nothing.total], [false, 0]);
});

test('what staff are told after Add everything to cart', () => {
  const fee = { title: 'GM seat: Curse of Strahd (KT-OGRE-2)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'KT-OGRE-2' } };
  const coke = { variantId: 1, qty: 2, title: 'Coke', price: 350 };
  const fees = (over = {}) => ({ added: [], skipped: [], unlinked: [], failed: [], ...over });
  const tab = (over = {}) => ({ already: false, added: [], declined: [], untagged: [], failed: [], bad: [], markProblem: '', ...over });
  // Everything went in and the Lair app had nothing to say: the screen closes by itself.
  assert.deepEqual(everythingOutcome({ fees: fees({ added: [fee, owedLine] }), tab: tab({ added: [coke] }), customer: 'added' }, 'Kai'), {
    toast: 'Added $30 and 2 items from the tab. Ready to pay.',
    problem: null,
    close: true,
    next: null,
  });
  assert.deepEqual(everythingOutcome({ fees: fees({ added: [fee], failed: [{ line: owedLine, message: 'POS refused addCustomSale.' }] }), tab: null, customer: 'added' }, 'Kai'), {
    toast: 'Added $15. Ready to pay.',
    problem: {
      title: "Some of it isn't in the cart",
      message: 'POS said: POS refused addCustomSale. Add it by hand as a custom sale: Owed: Curse of Strahd (Thu 1 Oct), $15.00.',
      tone: 'critical',
    },
    close: false,
    next: 'close',
  });
  // What the Lair app said at check-in keeps the screen open, with Close and pay.
  const notice = 'Pass SJ-KIWI-4 had 2 sessions left, so it covered 2 of 3 people.';
  assert.deepEqual(everythingOutcome({ fees: fees({ added: [fee] }), tab: null, customer: 'added' }, 'Kai', [notice, '']), {
    toast: 'Added $15. Ready to pay.',
    problem: { title: 'Check before they pay', message: notice, tone: 'warning' },
    close: false,
    next: 'close',
  });
  assert.equal(
    everythingOutcome({ fees: fees({ added: [fee], unlinked: [fee] }), tab: null, customer: 'added' }, 'Kai', [notice]).problem?.message,
    `Paying won't mark KT-OGRE-2 paid by itself. After they pay, mark it paid on the staff page. ${notice}`,
    'notices join any other banner',
  );
  assert.deepEqual(everythingOutcome({ fees: fees({ added: [fee], unlinked: [fee] }), tab: tab({ added: [coke], markProblem: "Can't reach the Lair app." }), customer: 'added' }).problem, {
    title: 'Check the cart',
    message:
      "Paying won't mark KT-OGRE-2 paid by itself. After they pay, mark it paid on the staff page. The Lair app wasn't told the tab is at the counter (Can't reach the Lair app.), so they could still change it in My Lair.",
    tone: 'warning',
  });
  assert.deepEqual(everythingOutcome({ fees: fees({ skipped: [fee] }), tab: tab({ already: true }), customer: 'already' }), {
    toast: '',
    problem: { title: 'Already in the cart', message: "It's all in this sale already. Take payment with Pay on Verifone.", tone: 'info' },
    close: false,
    next: 'close',
  });
  assert.deepEqual(everythingOutcome({ fees: fees({ added: [fee] }), tab: null, customer: 'failed' }, 'Kai').problem, {
    title: "Couldn't put Kai on the sale",
    message: "Add them with the cart's Add customer button, so their spend counts.",
    tone: 'info',
  });
  const nothing = everythingOutcome({ fees: fees(), tab: tab({ failed: [{ item: coke, message: 'Out of stock' }] }), customer: 'none' });
  assert.deepEqual([nothing.problem?.title, nothing.close, nothing.next], ["It isn't in the cart", false, null], 'nothing in the cart: no Close and pay');
});

test('the words for a tab that didn\'t all go in, and for fees POS refused', () => {
  const coke = { variantId: 1, qty: 1, title: 'Coke', price: 350 };
  const pie = { variantId: 2, qty: 1, title: 'Pie', price: 600 };
  assert.deepEqual(
    tabNotes({ failed: [{ item: coke, message: 'POS refused addLineItem' }], declined: [pie], bad: ['Mystery'], untagged: [pie], markProblem: 'Timed out' }),
    [
      "POS couldn't add Coke (POS refused addLineItem).",
      'Not added: Pie.',
      'Ring these up by hand: Mystery.',
      "Pie isn't linked to the tab, so paying won't mark the tab paid by itself.",
      "The Lair app wasn't told the tab is at the counter (Timed out), so they could still change it in My Lair.",
    ],
  );
  assert.deepEqual(tabNotes({ failed: [], declined: [], bad: [], untagged: [], markProblem: '' }), []);
  assert.equal(failedFeesText([{ line: owedLine, message: 'Nope!' }]), 'POS said: Nope. Add it by hand as a custom sale: Owed: Curse of Strahd (Thu 1 Oct), $15.00.');
});

/* ---------------- the 27 Oct 2026 rework: fewer taps to payment ---------------- */

test('the person view’s one main button: check in and add in one tap, or just check in to pay later', () => {
  /** @param {any} r @param {any} [extra] */
  const act = (r, extra = {}) =>
    personAction({ row: r, plan: personPlan(r, extra.result ?? null, TODAY), choice: extra.choice ?? null, inCart: false, share: 'none', justChecked: false });
  const one = { ...row, people: 1, due: 1500, amount: 1500 };
  assert.deepEqual(act(one), {
    action: 'check-in-add',
    label: 'Check in and add $15 to cart',
    force: false,
    hint: CLOSES,
    more: [{ action: 'check-in-only', label: 'Just check in (pay later)' }],
  });
  // Three people: they could split it.
  assert.deepEqual(act(row).more.map((m) => m.action), ['check-in-only', 'check-in-split']);
  // They said they'd split when booking: that leads.
  assert.deepEqual([act({ ...row, split: true }).action, act({ ...row, split: true }).label], ['check-in-split', 'Check in, then split the bill']);
  // A saved pass is picked: it comes off first, and anything left goes in the cart.
  const withPass = act({ ...one, pass: kiwi }, { choice: 'SJ-KIWI-4' });
  assert.deepEqual([withPass.action, withPass.label, withPass.hint], ['check-in-add', 'Check in with the pass', "Anything the pass doesn't cover goes in the cart."]);
  assert.equal(act({ ...one, pass: kiwi }, { choice: NO_PASS }).label, 'Check in and add $15 to cart', 'the pass turned off');
  assert.equal(act({ ...one, type: 'join' }, { choice: 'SJ-KIWI-4' }).label, 'Check in and add $15 to cart', 'passes never cover event entry');
  // Nothing to pay, or a warning first.
  assert.deepEqual([act({ ...one, due: 0, paid: true }).action, act({ ...one, due: 0, paid: true }).label], ['check-in', 'Check in']);
  const other = act({ ...one, start: at(4, 19), end: at(4, 22) });
  assert.deepEqual([other.action, other.label, other.force], ['check-in', 'Check in anyway', true]);
});

test('once they’re here: add to cart, close and pay once it’s in the cart, or ready for the next scan', () => {
  const here = { ...row, people: 1, status: 'seated', arrivedAt: 1, due: 1500 };
  /** @param {any} r @param {any} [extra] */
  const act = (r, extra = {}) => personAction({ row: r, plan: personPlan(r, null, TODAY), choice: null, inCart: false, share: 'none', justChecked: false, ...extra });
  assert.deepEqual(act(here), { action: 'add', label: 'Add $15 to cart', force: false, hint: CLOSES, more: [] });
  assert.deepEqual(act({ ...here, people: 3 }).more, [{ action: 'split', label: 'Split the bill' }]);
  assert.deepEqual([act(here, { inCart: true }).action, act(here, { inCart: true }).label], ['close', 'Close and pay']);
  assert.equal(act(here, { share: 'in-cart' }).action, 'close', 'a share of it is in the cart');
  // A share left the cart and its payment hasn't reached the Lair app yet: look again, or say it wasn't paid.
  assert.deepEqual(act(here, { share: 'waiting' }), {
    action: 'refresh',
    label: 'Refresh',
    force: false,
    hint: 'Tap Refresh in a few seconds to see the last payment.',
    more: [{ action: 'forget', label: "It wasn't paid" }],
  });
  const done = { ...here, due: 0, paid: true };
  assert.deepEqual(act(done, { justChecked: true }), { action: 'done', label: 'Done', force: false, hint: 'Or scan the next code.', more: [{ action: 'back', label: 'Back' }] });
  assert.equal(act(done).action, 'back', 'opened just to look: back where they came from');
  // Paid, never checked in: an owed session, or a GM's charge for a player's seat.
  assert.deepEqual([act(lastWeek).action, act(lastWeek).label], ['add', 'Add $15 to cart']);
  assert.equal(act(lastWeek, { inCart: true }).action, 'close');
  assert.equal(act({ ...lastWeek, due: 0 }).action, 'back');
  const charge = { id: 'bk_cv', type: 'booking', kind: 'gm-cover', ref: 'KA-OWL-12', name: 'Kate Moana', status: 'confirmed', due: 1000, start: at(3, 18), end: at(3, 22) };
  assert.deepEqual(personPlan(charge, null, TODAY), { stage: 'owed', force: false, warning: '' });
  assert.deepEqual([act(charge).action, act(charge).label], ['add', 'Add $10 to cart']);
});

test('once they’re here: a pass picked for what’s left leads, and so does splitting when they’re splitting', () => {
  const here = { ...row, people: 1, status: 'seated', arrivedAt: 1, due: 1500 };
  /** @param {any} r @param {any} [extra] */
  const act = (r, extra = {}) => personAction({ row: r, plan: personPlan(r, null, TODAY), choice: null, inUse: null, inCart: false, share: 'none', justChecked: false, ...extra });
  // Staff picked a pass under "Use a pass for what's left?": using it is the main button, never "Add $15 to cart".
  assert.deepEqual(act(here, { choice: 'SJ-KIWI-4' }), {
    action: 'use-pass',
    label: 'Use the pass',
    force: false,
    hint: "Anything the pass doesn't cover goes in the cart.",
    more: [],
  });
  assert.equal(act(here, { choice: NO_PASS }).action, 'add', '"Don\'t use a pass" picked');
  assert.equal(act(here, { choice: 'SJ-KIWI-4', inUse: { code: 'SJ-KIWI-4' } }).action, 'add', 'that pass is in use already');
  assert.equal(act(here, { choice: 'SJ-KIWI-4', inCart: true }).action, 'close', 'its fee is in the cart: take that payment, or the line off');
  // They said they'd split, or part is paid: splitting leads, and the whole remainder is the quieter button.
  const splitting = act({ ...here, people: 4, amount: 4000, paidAmount: 1000, due: 3000 });
  assert.deepEqual([splitting.action, splitting.label, splitting.more], ['split', 'Split the bill', [{ action: 'add', label: 'Add $30 to cart' }]]);
  assert.equal(act({ ...here, people: 4, split: true, due: 4000 }).action, 'split');
  assert.equal(act({ ...here, people: 4, due: 4000 }).action, 'add', 'nobody said they would split');
});

test('after Add to cart: the screen closes when it all went in, else it stays and says what to do', () => {
  const fee = { title: 'GM seat: Curse of Strahd (KT-OGRE-2)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'KT-OGRE-2' } };
  /** @param {any} [over] */
  const result = (over = {}) => ({ added: [], skipped: [], unlinked: [], failed: [], customer: 'added', ...over });
  assert.deepEqual(afterCart(result({ added: [fee] }), { who: 'Kai', ref: 'KT-OGRE-2' }), { close: true, toast: 'Added $15 for Kai. Ready to pay.', banner: null, next: null });
  assert.deepEqual(
    afterCart(result({ added: [fee], customer: 'other' })),
    { close: true, toast: 'Added $15. Ready to pay.', banner: null, next: null },
    'someone else on the sale: the strip showed it',
  );
  assert.deepEqual(afterCart(result({ skipped: [fee] })), {
    close: false,
    toast: '',
    banner: { title: 'Already in the cart', message: 'Take payment with Pay on Verifone, or take that line off the sale first.', tone: 'info' },
    next: 'close',
  });
  const failed = afterCart(result({ failed: [{ line: fee, message: 'Nope' }] }));
  assert.deepEqual([failed.close, failed.toast, failed.banner?.title, failed.banner?.tone, failed.next], [false, '', "It isn't in the cart", 'critical', null]);
  assert.deepEqual(
    [afterCart(result({ added: [fee], failed: [{ line: fee, message: 'Nope' }] })).banner?.title, afterCart(result({ added: [fee], failed: [{ line: fee, message: 'Nope' }] })).next],
    ["Some of it isn't in the cart", 'close'],
  );
  assert.deepEqual(afterCart(result({ added: [fee], unlinked: [fee] }), { ref: 'KT-OGRE-2' }).banner, {
    title: "It's in the cart, but not linked",
    message: "Paying won't mark KT-OGRE-2 paid by itself. After they pay, mark it paid on the staff page.",
    tone: 'warning',
  });
  const noCustomer = afterCart(result({ added: [fee], customer: 'failed' }), { who: 'Kai' });
  assert.deepEqual([noCustomer.close, noCustomer.banner?.title, noCustomer.next], [false, "Couldn't put Kai on the sale", 'close']);
});

test('what the Lair app said at check-in is never closed away unread', () => {
  const fee = { title: 'Table fee: SJ-OWLBEAR-17 (T4, 3 people)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17' } };
  const result = { added: [fee], skipped: [], unlinked: [], failed: [], customer: 'added' };
  const partly = 'Pass SJ-KIWI-4 had 2 sessions left, so it covered 2 of 3 people.';
  assert.deepEqual(afterCart(result, { who: 'Sam', notices: [partly] }), {
    close: false,
    toast: 'Added $15 for Sam. Ready to pay.',
    banner: { title: 'Check before they pay', message: partly, tone: 'warning' },
    next: 'close',
  });
  const expired = 'Pass SJ-KIWI-4 expired on 30 Sept 2026, so it wasn\'t used.';
  assert.equal(afterCart(result, { notices: [expired, partly] }).banner?.message, `${expired} ${partly}`);
  assert.equal(afterCart(result, { notices: ['', '  '] }).close, true, 'nothing said: it closes');
  assert.equal(afterCart(result, { notices: [] }).close, true);
});

test('a group paying together: tick them, then one button checks them in and puts their fees in one sale', () => {
  const sam = { ...row, id: 'bk_sam', people: 1, due: 1500, customerId: '777' };
  const alex = { ...row, id: 'bk_alex', ref: 'AC-OTTER-3', name: 'Alex Chen', people: 1, due: 1500, customerId: '888' };
  const jo = { ...row, id: 'bk_jo', ref: 'JS-MOA-2', name: 'Jo Smith', people: 2, due: 3000, customerId: '777', pass: kiwi };
  const mia = { ...row, id: 'bk_mia', ref: 'MB-OTTER-9', name: 'Mia Brown', kind: 'gm-seat', people: 1, due: 0, amount: 0, gmPays: { on: true } };
  const rangi = { ...row, id: 'bk_rangi', ref: 'RW-TUI-8', name: 'Rangi Walker', people: 1, status: 'seated', arrivedAt: 1, due: 0, paid: true };
  const zoe = { ...row, id: 'bk_zoe', ref: 'ZB-KEA-20', name: 'Zoë', people: 1, status: 'seated', arrivedAt: 1, due: 1500 };
  const cleo = { ...row, id: 'bk_cleo', ref: 'CL-OTTER-3', name: 'Cleo', people: 1, status: 'noshow', due: 1500 };
  const rows = [sam, alex, jo, mia, rangi, zoe, cleo];
  const none = groupPlan(rows, []);
  assert.deepEqual(none.tickable, ['booking:bk_sam', 'booking:bk_alex', 'booking:bk_jo', 'booking:bk_mia', 'booking:bk_zoe']);
  assert.deepEqual(none.toCome, ['booking:bk_sam', 'booking:bk_alex', 'booking:bk_jo', 'booking:bk_mia']);
  assert.equal(none.label, '');
  const three = groupPlan(rows, ['booking:bk_sam', 'booking:bk_alex', 'booking:bk_mia']);
  assert.deepEqual([three.label, three.due, three.customerId, three.passNote], ['Check in 3 people and add $30 to cart', 3000, null, false]);
  assert.deepEqual(three.checkIn.map((r) => r.id), ['bk_sam', 'bk_alex', 'bk_mia']);
  // One person's bookings: they go on the sale; a saved pass may take some off.
  const family = groupPlan(rows, ['booking:bk_sam', 'booking:bk_jo']);
  assert.deepEqual([family.label, family.customerId, family.passNote], ['Check in 3 people and add $45 to cart', '777', true]);
  // Here already, with something to pay: just their fee.
  const owing = groupPlan(rows, ['booking:bk_zoe']);
  assert.deepEqual([owing.label, owing.add.map((r) => r.id), owing.checkIn.length], ['Add $15 to cart', ['bk_zoe'], 0]);
  // Nothing to pay: just check them in.
  assert.equal(groupPlan(rows, ['booking:bk_mia']).label, 'Check in 1 person');
  // Ticks that can't be ticked any more count for nothing; a fee in the cart isn't added again.
  assert.equal(groupPlan(rows, ['booking:bk_rangi', 'booking:bk_cleo']).label, '');
  assert.equal(groupPlan(rows, ['booking:bk_zoe'], ['ZB-KEA-20']).tickable.includes('booking:bk_zoe'), false);
  assert.equal(groupPlan(rows, ['booking:bk_sam'], [String(sam.ref)]).label, 'Check in 1 person', 'its fee is in the cart already');
  // Owed seats are paid, never ticked to check in.
  assert.deepEqual(groupPlan([lastWeek], []).tickable, []);
  assert.deepEqual(groupScreen('game:1'), { name: 'group', key: 'game:1', ticked: [], picking: false });
});

test('why someone checked in has nothing to pay', () => {
  assert.equal(whyNothing({ id: 1, amount: 1500, paidAmount: 1500, paid: true, due: 0 }), "Nothing to pay: it's paid.");
  assert.equal(whyNothing({ id: 1, amount: 1500, covered: 1500, due: 0 }), 'Nothing to pay: their pass covers it.');
  assert.equal(whyNothing({ id: 1, amount: 1500, waived: true, due: 0 }), 'Nothing to pay: it was waived.');
  assert.equal(whyNothing({ id: 1, kind: 'gm-seat', amount: 0, due: 0, gmPays: { on: true, payer: 'Kate' } }), 'Nothing to pay: Kate is paying for this seat.');
  assert.equal(whyNothing({ id: 1, amount: 0, due: 0 }), 'Nothing to pay.');
});

test('a GM’s charge is never checked in, but its line is there to pay', () => {
  const line = { title: "Paying for Mia's seat: Curse of Strahd (KA-OWL-12)", price: '10.00', quantity: 1, taxable: true, properties: { _booking: 'KA-OWL-12' } };
  const outcome = checkinOutcome({ checkedIn: false, reason: 'cover', row: { id: 'bk_cv', kind: 'gm-cover', ref: 'KA-OWL-12', due: 1000 }, lines: [line] });
  assert.deepEqual([outcome.arrived, outcome.payOnly, outcome.total, outcome.text, outcome.refused], [false, true, 1000, '$10 to pay.', '']);
  const gone = checkinOutcome({ checkedIn: false, reason: 'cover', row: { id: 'bk_cv', kind: 'gm-cover', due: 0 }, lines: [] });
  assert.deepEqual([gone.payOnly, gone.total, gone.text], [true, 0, 'Nothing to pay.']);
});

test('a GM’s member code: their charges for their players’ seats are paid with the rest, never checked in', () => {
  const charge = {
    id: 'bk_cv',
    type: 'booking',
    kind: 'gm-cover',
    ref: 'KA-OWL-12',
    name: 'Kate Moana',
    title: "Paying for Mia's seat: Curse of Strahd",
    status: 'confirmed',
    due: 1000,
    start: at(3, 18),
    end: at(3, 22),
    customerId: '555',
  };
  assert.deepEqual(memberPlan([charge]), { canCheckIn: true, waiting: 0, due: 1000, coming: [], owing: [charge] });
  assert.deepEqual(memberPlan([charge], ['KA-OWL-12']), { canCheckIn: false, waiting: 0, due: 0, coming: [], owing: [] }, 'in the cart already');
  const kate = { ...tonight, id: 'bk_kate', ref: 'KM-WETA-5', name: 'Kate Moana', customerId: '555', seriesId: null };
  const plan = everythingPlan([kate, charge, lastWeek], kaiTab);
  assert.deepEqual([plan.label, plan.parts, plan.total], ['Check in and add everything · $47', "Today $15 · Players' seats $10 · Owed $15 · Tab $7", 4700]);
  const only = everythingPlan([charge], null);
  assert.deepEqual([only.label, only.separate, only.parts], ['Add $10 to cart', false, '']);
});

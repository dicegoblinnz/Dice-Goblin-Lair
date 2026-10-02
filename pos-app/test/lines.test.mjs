// What goes in the POS cart after a check-in or for a member's tab: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addedToast,
  feeLines,
  itemCount,
  linesTotal,
  NOTHING_TO_PAY,
  passUsedLabel,
  shareLines,
  tabItems,
  tabSummary,
  tabToast,
} from '../extensions/lair-checkin/src/lines.js';

const line = { title: 'Table fee: SJ-OWLBEAR-17 (T4, 3 people)', price: '45.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17' } };

test('uses the fee lines the Lair app sends, each tagged with its booking', () => {
  const answer = { row: { id: 'bk_sam', ref: 'SJ-OWLBEAR-17', due: 4500 }, lines: [line] };
  assert.deepEqual(feeLines(answer), [line]);
  assert.equal(linesTotal(feeLines(answer)), 4500);
});

test('tidies lines: numbers as prices, the booking added when a line leaves it out, broken lines dropped', () => {
  const answer = {
    row: { ref: 'SJ-OWLBEAR-17' },
    lines: [
      { title: 'Table fee', price: 15, quantity: 2 },
      { title: 'Bad', price: 'abc' },
      { title: 'Free', price: '0.00' },
      null,
    ],
  };
  const lines = feeLines(answer);
  assert.deepEqual(lines, [{ title: 'Table fee', price: '15.00', quantity: 2, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17' } }]);
  assert.equal(linesTotal(lines), 3000);
});

test('keeps each line’s own booking when a member checks in several', () => {
  const answer = {
    rows: [],
    lines: [
      { ...line },
      { title: 'GM seat: Curse of Strahd (SJ-GOLEM-3)', price: '20.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-GOLEM-3' } },
    ],
  };
  assert.deepEqual(
    feeLines(answer).map((l) => l.properties._booking),
    ['SJ-OWLBEAR-17', 'SJ-GOLEM-3'],
  );
  assert.equal(linesTotal(feeLines(answer)), 6500);
});

test('nothing due means nothing in the cart; no lines at all falls back to what the row says is due', () => {
  assert.deepEqual(feeLines({ row: { ref: 'SJ-OWLBEAR-17', due: 0 }, lines: [] }), []);
  assert.deepEqual(feeLines({ row: { ref: 'SJ-OWLBEAR-17', due: 1500 }, lines: [] }), [], 'an empty list from the Lair app is trusted');
  assert.deepEqual(feeLines({ row: { ref: 'SJ-OWLBEAR-17', due: 1500 } }), [
    { title: 'Table fee: SJ-OWLBEAR-17', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17' } },
  ]);
  assert.deepEqual(feeLines({ row: { ref: 'JO-PIXIE-1', type: 'join', due: 1000 } })[0].title, 'Event entry: JO-PIXIE-1');
  assert.deepEqual(feeLines(null), []);
});

test('a line with no booking at all still goes in (the money is owed)', () => {
  const lines = feeLines({ lines: [{ title: 'Mystery', price: '5.00' }] });
  assert.deepEqual(lines, [{ title: 'Mystery', price: '5.00', quantity: 1, taxable: true, properties: {} }]);
});

test('turns a tab into products for the cart', () => {
  const tab = {
    id: 'tab_1',
    items: [
      { variantId: '44123456789012', title: 'Coke', variantTitle: '330ml can', price: 350, qty: 2 },
      { variantId: '44123456789013', title: 'Ice cream', variantTitle: 'Default Title', price: 400, qty: 99 },
      { variantId: 'gid://shopify/ProductVariant/1', title: 'Odd one', price: 100, qty: 1 },
      { variantId: '', title: 'No id', price: 100, qty: 1 },
    ],
    total: 1500,
  };
  const { items, bad } = tabItems(tab);
  assert.deepEqual(items, [
    { variantId: 44123456789012, qty: 2, title: 'Coke – 330ml can', price: 350 },
    { variantId: 44123456789013, qty: 20, title: 'Ice cream', price: 400 },
  ]);
  assert.deepEqual(bad, ['Odd one', 'No id']);
  assert.equal(tabSummary(tab), '24 items · $15');
  assert.equal(tabSummary({ items: [{ variantId: '1', price: 250, qty: 2 }] }), '2 items · $5');
  assert.deepEqual(tabItems(null), { items: [], bad: [] });
});

test('a share of a bill is one line, tagged with its booking and as a share', () => {
  const answer = {
    row: { id: 'bk_sam', ref: 'SJ-OWLBEAR-17', due: 4000 },
    line: {
      title: 'Table fee share: SJ-OWLBEAR-17 ($10 of $40 left)',
      price: '10.00',
      quantity: 1,
      taxable: true,
      properties: { _booking: 'SJ-OWLBEAR-17', _share: '1' },
    },
  };
  assert.deepEqual(shareLines(answer), [answer.line]);
  assert.deepEqual(shareLines({ row: answer.row, line: { title: 'Share', price: '12.50' } }), [
    { title: 'Share', price: '12.50', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17', _share: '1' } },
  ]);
  assert.deepEqual(shareLines({ row: answer.row }), []);
  assert.deepEqual(shareLines(null), []);
});

test('says what happened in plain words', () => {
  assert.equal(addedToast(1500), 'Added $15. Ready to pay.');
  assert.equal(addedToast(1250), 'Added $12.50. Ready to pay.');
  assert.equal(tabToast(3), 'Added 3 items from the tab. Ready to pay.');
  assert.equal(tabToast(1), 'Added 1 item from the tab. Ready to pay.');
  assert.equal(itemCount([{ variantId: 1, qty: 2, title: 'Coke', price: 350 }, { variantId: 2, qty: 1, title: 'Ice cream', price: 400 }]), 3);
  assert.equal(NOTHING_TO_PAY, 'Checked in. Nothing to pay.');
  assert.equal(passUsedLabel({ code: 'SJ-KIWI-4', label: 'Warhammer league', used: 2, left: 6, covered: 2000 }), 'Warhammer league covered $20 · 6 sessions left');
  assert.equal(passUsedLabel({ label: 'Gift pack', left: 1, covered: 0 }), 'Gift pack used · 1 session left');
  assert.equal(passUsedLabel(null), '');
});

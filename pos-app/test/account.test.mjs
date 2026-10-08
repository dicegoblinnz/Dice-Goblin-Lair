// Round 9: monthly accounts at the counter: the member view's word about the account, a tab row from an earlier day,
// and its line going in the cart tagged with the tab. `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountLine, owedLines } from '../extensions/lair-checkin/src/lines.js';
import { nextScreen } from '../extensions/lair-checkin/src/flow.js';
import { whatLabel } from '../extensions/lair-checkin/src/today.js';

test('a monthly account says its fees go on the account, with what is owed and any warning; paying each visit says nothing', () => {
  assert.equal(accountLine({ billing: 'visit' }), '');
  assert.equal(accountLine(null), '');
  assert.equal(
    accountLine({ billing: 'monthly', creditLimit: 10000, owed: 4500, available: 5500, warning: null }),
    "Today's fees go on their account ($45 owed of $100). Add to the cart only if they want to pay now.",
  );
  assert.equal(
    accountLine({ billing: 'monthly', creditLimit: 10000, owed: 10500, warning: 'Over their $100 limit: $105 owed.' }),
    "Today's fees go on their account ($105 owed of $100). Add to the cart only if they want to pay now. Over their $100 limit: $105 owed.",
  );
});

test("the scan's account reaches the member screen", () => {
  const screen = nextScreen({ type: 'member', member: { customerId: '1001', name: 'Sam' }, rows: [], tab: null, passes: [], account: { billing: 'monthly', owed: 0, creditLimit: 5000 } });
  assert.deepEqual(screen.account, { billing: 'monthly', owed: 0, creditLimit: 5000 });
  assert.equal(nextScreen({ type: 'member', member: { customerId: '1001' } }).account, null);
});

test("an earlier day's tab on a monthly account is a Tab row whose line keeps _tab (and the tile's _booking stand-in)", () => {
  const row = {
    id: 'tb_1234567890abcdef', type: 'tab', kind: 'tab', ref: 'TAB-ABCDEF', title: 'Tab', start: 1, end: 2, owed: true, onAccount: true, due: 900,
    line: { title: 'Tab: Tue 15 Sep (2 things)', price: '9.00', quantity: 1, taxable: true, properties: { _tab: 'tb_1234567890abcdef' } },
  };
  assert.equal(whatLabel(row), 'Tab');
  assert.deepEqual(owedLines([row]), [{
    title: 'Tab: Tue 15 Sep (2 things)', price: '9.00', quantity: 1, taxable: true, properties: { _tab: 'tb_1234567890abcdef', _booking: 'TAB-ABCDEF' },
  }]);
});

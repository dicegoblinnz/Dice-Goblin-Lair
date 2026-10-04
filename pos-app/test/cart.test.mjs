// Putting fees, shares, tabs and members in the POS cart, with a pretend POS cart: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { addEverythingToCart, addFeesToCart, addTabToCart, bookingsInCart, putOnSale, sharesInCart, tabsInCart } from '../extensions/lair-checkin/src/cart.js';

/**
 * A pretend POS cart that records every call.
 * @param {{ lineItems?: any[], customer?: { id: number }, refuse?: string[], declineVariant?: number, ignoreOptions?: boolean }} [options]
 */
function pretendCart({ lineItems = [], customer, refuse = [], declineVariant, ignoreOptions = false } = {}) {
  /** @type {any[]} */
  const calls = [];
  const state = { lineItems: lineItems.map((l) => ({ properties: {}, ...l })), customer };
  let n = 0;
  const maybeRefuse = (name) => {
    if (refuse.includes(name)) throw new Error(`POS refused ${name}`);
  };
  globalThis.shopify = /** @type {any} */ ({
    cart: {
      current: {
        get value() {
          return state;
        },
        subscribe: () => () => {},
      },
      async addCustomSale(sale) {
        calls.push(['addCustomSale', sale]);
        maybeRefuse('addCustomSale');
        const uuid = `line-${(n += 1)}`;
        state.lineItems.push({ uuid, title: sale.title, properties: {} });
        return uuid;
      },
      async addLineItemProperties(uuid, properties) {
        calls.push(['addLineItemProperties', uuid, properties]);
        maybeRefuse('addLineItemProperties');
        Object.assign(state.lineItems.find((l) => l.uuid === uuid).properties, properties);
      },
      async addLineItem(variantId, quantity, options) {
        calls.push(['addLineItem', variantId, quantity, options]);
        maybeRefuse('addLineItem');
        if (variantId === declineVariant) return '';
        const uuid = `line-${(n += 1)}`;
        state.lineItems.push({ uuid, variantId, quantity, properties: ignoreOptions ? {} : { ...(options?.properties || {}) } });
        return uuid;
      },
      async setCustomer(c) {
        calls.push(['setCustomer', c]);
        maybeRefuse('setCustomer');
        state.customer = c;
      },
    },
  });
  return { calls, state };
}

afterEach(() => {
  delete globalThis.shopify;
});

const fee = (ref, price = '15.00') => ({ title: `Table fee: ${ref}`, price, quantity: 1, taxable: true, properties: { _booking: ref } });

test('adds each fee as a custom sale, tags it with its booking, then puts the customer on the sale', async () => {
  const { calls, state } = pretendCart();
  const result = await addFeesToCart([fee('SJ-OWLBEAR-17'), fee('SJ-GOLEM-3', '20.00')], '777');
  assert.deepEqual(calls, [
    ['addCustomSale', { title: 'Table fee: SJ-OWLBEAR-17', price: '15.00', quantity: 1, taxable: true }],
    ['addLineItemProperties', 'line-1', { _booking: 'SJ-OWLBEAR-17' }],
    ['addCustomSale', { title: 'Table fee: SJ-GOLEM-3', price: '20.00', quantity: 1, taxable: true }],
    ['addLineItemProperties', 'line-2', { _booking: 'SJ-GOLEM-3' }],
    ['setCustomer', { id: 777 }],
  ]);
  assert.equal(result.added.length, 2);
  assert.equal(result.customer, 'added');
  assert.deepEqual(bookingsInCart(state), ['SJ-OWLBEAR-17', 'SJ-GOLEM-3']);
  assert.deepEqual(sharesInCart(state), []);
});

test('never adds the same booking twice, and leaves another customer on the sale alone', async () => {
  const { calls } = pretendCart({ lineItems: [{ uuid: 'old', properties: { _booking: 'SJ-OWLBEAR-17' } }], customer: { id: 9 } });
  const result = await addFeesToCart([fee('SJ-OWLBEAR-17')], 777);
  assert.deepEqual(calls, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.customer, 'other');
});

test('a share goes in tagged as a share, and the person paying it replaces whoever was on the sale', async () => {
  const { calls, state } = pretendCart({ customer: { id: 9 } });
  const share = { title: 'Table fee share: SJ-OWLBEAR-17 ($10 of $40 left)', price: '10.00', quantity: 1, taxable: true, properties: { _booking: 'SJ-OWLBEAR-17', _share: '1' } };
  const result = await addFeesToCart([share], '555', { replaceCustomer: true });
  assert.deepEqual(calls, [
    ['addCustomSale', { title: share.title, price: '10.00', quantity: 1, taxable: true }],
    ['addLineItemProperties', 'line-1', { _booking: 'SJ-OWLBEAR-17', _share: '1' }],
    ['setCustomer', { id: 555 }],
  ]);
  assert.equal(result.customer, 'added');
  assert.deepEqual(sharesInCart(state), ['SJ-OWLBEAR-17']);
  const again = await addFeesToCart([share], '555', { replaceCustomer: true });
  assert.equal(again.skipped.length, 1, 'one share of a bill in the cart at a time');
  assert.equal(again.customer, 'already');
});

test('a fee POS took without its booking tag is flagged; one POS refused is reported', async () => {
  pretendCart({ refuse: ['addLineItemProperties'] });
  const unlinked = await addFeesToCart([fee('SJ-OWLBEAR-17')], null);
  assert.equal(unlinked.added.length, 1);
  assert.equal(unlinked.unlinked.length, 1);
  assert.equal(unlinked.customer, 'none');
  pretendCart({ refuse: ['addCustomSale'] });
  const failed = await addFeesToCart([fee('SJ-OWLBEAR-17')], 777);
  assert.equal(failed.added.length, 0);
  assert.deepEqual(failed.failed.map((f) => f.message), ['POS refused addCustomSale']);
  assert.equal(failed.customer, 'none', 'no customer for a sale with nothing in it');
});

test('adds a tab as real products tagged with the tab, tells the Lair app, then puts the member on the sale', async () => {
  const { calls, state } = pretendCart();
  const tab = {
    id: 'tab_1',
    items: [
      { variantId: '44123456789012', title: 'Coke', price: 350, qty: 2 },
      { variantId: '44123456789013', title: 'Ice cream', price: 400, qty: 1 },
      { variantId: 'nope', title: 'Mystery', price: 100, qty: 1 },
    ],
  };
  const marked = [];
  const markAdded = async (id) => {
    calls.push(['markAdded', id]);
    marked.push(id);
  };
  const result = await addTabToCart(tab, '777', markAdded);
  assert.deepEqual(calls, [
    ['addLineItem', 44123456789012, 2, { properties: { _tab: 'tab_1' } }],
    ['addLineItem', 44123456789013, 1, { properties: { _tab: 'tab_1' } }],
    ['markAdded', 'tab_1'],
    ['setCustomer', { id: 777 }],
  ]);
  assert.equal(result.added.length, 2);
  assert.deepEqual(result.bad, ['Mystery']);
  assert.equal(result.customer, 'added');
  assert.deepEqual(tabsInCart(state), ['tab_1', 'tab_1']);
  const again = await addTabToCart(tab, '777', markAdded);
  assert.equal(again.already, true);
  assert.equal(again.added.length, 0);
  assert.deepEqual(marked, ['tab_1'], 'only told once');
});

test('a tab line that comes back without _tab gets it straight after', async () => {
  const { calls, state } = pretendCart({ ignoreOptions: true });
  const result = await addTabToCart({ id: 'tab_3', items: [{ variantId: '7', title: 'Coke', qty: 1 }] }, null, async () => {});
  assert.deepEqual(calls[1], ['addLineItemProperties', 'line-1', { _tab: 'tab_3' }]);
  assert.deepEqual(tabsInCart(state), ['tab_3']);
  assert.equal(result.untagged.length, 0);
});

test('an item staff decline at the stock prompt is reported, not added, and the Lair app is not told', async () => {
  pretendCart({ declineVariant: 44123456789012 });
  let told = false;
  const result = await addTabToCart({ id: 'tab_2', items: [{ variantId: '44123456789012', title: 'Coke', qty: 1 }] }, null, async () => {
    told = true;
  });
  assert.equal(result.added.length, 0);
  assert.equal(result.declined.length, 1);
  assert.equal(told, false);
});

test('the tab stays in the cart when the Lair app cannot be told', async () => {
  pretendCart();
  const result = await addTabToCart({ id: 'tab_4', items: [{ variantId: '7', title: 'Coke', qty: 1 }] }, '777', async () => {
    throw new Error("Can't reach the Lair app. Check the iPad's internet and try again.");
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.markProblem, "Can't reach the Lair app. Check the iPad's internet and try again.");
  assert.equal(result.customer, 'added');
});

test('puts a member on the sale, and only replaces someone else when asked', async () => {
  pretendCart({ customer: { id: 9 } });
  assert.equal(await putOnSale('777'), 'other');
  assert.equal(await putOnSale('gid://shopify/Customer/9'), 'already');
  assert.equal(await putOnSale('777', true), 'added');
  assert.equal(await putOnSale(null), 'none');
  pretendCart({ refuse: ['setCustomer'] });
  assert.equal(await putOnSale('777'), 'failed');
});

test('Add everything to cart: fees, then owed sessions, then the tab tagged _tab, then the member, then the Lair app is told', async () => {
  const { calls, state } = pretendCart();
  const owed = { title: 'Owed: Curse of Strahd (Thu 1 Oct)', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'KT-KRAKEN-7' } };
  const tab = { id: 'tab_kai', items: [{ variantId: '44123456789012', title: 'Coke', price: 350, qty: 2 }] };
  const markAdded = async (id) => {
    calls.push(['markAdded', id]);
  };
  const result = await addEverythingToCart({ lines: [fee('KT-OGRE-2'), owed], tab, customerId: '888', markAdded });
  assert.deepEqual(calls, [
    ['addCustomSale', { title: 'Table fee: KT-OGRE-2', price: '15.00', quantity: 1, taxable: true }],
    ['addLineItemProperties', 'line-1', { _booking: 'KT-OGRE-2' }],
    ['addCustomSale', { title: 'Owed: Curse of Strahd (Thu 1 Oct)', price: '15.00', quantity: 1, taxable: true }],
    ['addLineItemProperties', 'line-2', { _booking: 'KT-KRAKEN-7' }],
    ['addLineItem', 44123456789012, 2, { properties: { _tab: 'tab_kai' } }],
    ['setCustomer', { id: 888 }],
    ['markAdded', 'tab_kai'],
  ]);
  assert.deepEqual([result.fees.added.length, result.tab?.added.length, result.tab?.markProblem, result.customer], [2, 1, '', 'added']);
  assert.deepEqual(bookingsInCart(state), ['KT-OGRE-2', 'KT-KRAKEN-7']);
  assert.deepEqual(tabsInCart(state), ['tab_kai']);

  // A second tap adds nothing and tells the Lair app nothing.
  calls.length = 0;
  const again = await addEverythingToCart({ lines: [fee('KT-OGRE-2'), owed], tab, customerId: '888', markAdded });
  assert.deepEqual(calls, []);
  assert.deepEqual([again.fees.skipped.length, again.tab?.already, again.customer], [2, true, 'already']);
});

test('Add everything to cart: just fees, just a tab, or nothing; the tab stays in the cart when the Lair app cannot be told', async () => {
  const { calls } = pretendCart();
  const feesOnly = await addEverythingToCart({ lines: [fee('KT-OGRE-2')], tab: null, customerId: '888', markAdded: async () => assert.fail('no tab') });
  assert.deepEqual([feesOnly.tab, feesOnly.customer], [null, 'added']);
  assert.deepEqual(calls.map((c) => c[0]), ['addCustomSale', 'addLineItemProperties', 'setCustomer']);

  pretendCart();
  const tabOnly = await addEverythingToCart({
    lines: [],
    tab: { id: 'tab_kai', items: [{ variantId: '7', title: 'Coke', qty: 1 }] },
    customerId: '888',
    markAdded: async () => {
      throw new Error("Can't reach the Lair app. Check the iPad's internet and try again.");
    },
  });
  assert.deepEqual([tabOnly.tab?.added.length, tabOnly.tab?.markProblem, tabOnly.customer], [1, "Can't reach the Lair app. Check the iPad's internet and try again.", 'added']);

  const { calls: none } = pretendCart();
  const nothing = await addEverythingToCart({ lines: [], tab: null, customerId: '888', markAdded: async () => assert.fail('no tab') });
  assert.deepEqual([none, nothing.customer], [[], 'none'], 'nothing in the sale, so no customer either');
});

// The cart strip: what's in the sale and who's on it: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cartCents, customerNames, saleStrip } from '../extensions/lair-checkin/src/sale.js';

const today = {
  groups: [
    {
      key: 'tables',
      rows: [
        { id: 'bk_sam', name: 'Sam Jones', customerId: '777' },
        { id: 'bk_alex', name: 'Alex Chen', customerId: 'gid://shopify/Customer/888' },
        { id: 'bk_walk', name: 'Walk-in', customerId: null },
      ],
    },
  ],
};

test('names for the customers the screen knows, by customer number', () => {
  const names = customerNames(today, [{ customerId: '999', name: 'Mia Brown' }, { customerId: '777', name: 'Sam J (member)' }]);
  assert.equal(names.get(777), 'Sam J (member)', 'members seen on this screen first');
  assert.equal(names.get(888), 'Alex Chen');
  assert.equal(names.get(999), 'Mia Brown');
  assert.equal(names.size, 3);
  assert.equal(customerNames(null).size, 0);
});

test('what the cart comes to', () => {
  assert.equal(cartCents({ grandTotal: '15.00', lineItems: [] }), 1500);
  assert.equal(cartCents({ grandTotal: '12.5', lineItems: [] }), 1250);
  assert.equal(cartCents({ lineItems: [] }), 0);
  assert.equal(cartCents(null), 0);
});

test('the strip says what’s in the cart and who’s on the sale', () => {
  const names = customerNames(today);
  assert.deepEqual(saleStrip({ lineItems: [] }, names), { text: 'In the cart: nothing yet', tone: 'neutral', detail: '' });
  assert.deepEqual(saleStrip({ lineItems: [], customer: { id: 777 } }, names), { text: 'In the cart: nothing yet · Sam Jones is on the sale', tone: 'neutral', detail: '' });
  const samsSale = { lineItems: [{ uuid: 'a', properties: {} }], customer: { id: 777 }, grandTotal: '15.00' };
  assert.deepEqual(saleStrip(samsSale, names), { text: 'In the cart: $15 · Sam Jones', tone: 'neutral', detail: '' });
  assert.deepEqual(saleStrip(samsSale, names, { customerId: '777', name: 'Sam Jones' }), { text: 'In the cart: $15 · Sam Jones', tone: 'neutral', detail: '' }, 'their own sale');
  assert.deepEqual(saleStrip({ ...samsSale, customer: undefined }, names, { customerId: '888', name: 'Alex Chen' }), { text: 'In the cart: $15', tone: 'neutral', detail: '' }, 'nobody on it yet');
  assert.deepEqual(saleStrip({ ...samsSale, customer: { id: 4242 } }, names), { text: 'In the cart: $15 · a customer', tone: 'neutral', detail: '' });
});

test('someone else on a sale with things in it: a warning before adding to it', () => {
  const names = customerNames(today);
  const samsSale = { lineItems: [{ uuid: 'a', properties: {} }], customer: { id: 777 }, grandTotal: '20.00' };
  assert.deepEqual(saleStrip(samsSale, names, { customerId: '888', name: 'Alex Chen' }), {
    text: 'In the cart: $20 · Sam Jones',
    tone: 'warning',
    detail: "Alex's fee joins Sam's sale. If they're paying apart, take Sam's payment first.",
  });
  assert.deepEqual(saleStrip({ ...samsSale, customer: { id: 4242 } }, names, { customerId: '888', name: '' }), {
    text: 'In the cart: $20 · a customer',
    tone: 'warning',
    detail: "This fee joins the sale already in the cart. If they're paying apart, take that payment first.",
  });
});

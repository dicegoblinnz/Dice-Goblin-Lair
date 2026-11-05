// Round 30: the Lair is one class with modules' methods mixed in (Object.assign(Lair.prototype, …) at the end of
// src/lair.js). A module's method with a name the Lair already has quietly replaces it: round 30's store credit gifts
// once had a giftRow, which replaced the birthday gifts' own, and staff's birthday gifts failed. So no name may clash.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('round 30: no module mixed into the Lair replaces a method the Lair already has, or another module\'s', async () => {
  const real = Object.assign;
  const clashes = [];
  Object.assign = function assign(target, ...sources) {
    if (typeof target?.constructor === 'function' && target.constructor.name === 'Lair' && target === target.constructor.prototype) {
      for (const source of sources) for (const name of Object.keys(source || {})) if (name in target) clashes.push(name);
    }
    return real.call(Object, target, ...sources);
  };
  try {
    // a fresh copy of src/lair.js, so its mixing in runs again while it's watched
    await import(`../src/lair.js?mixins=${Date.now()}`);
  } finally {
    Object.assign = real;
  }
  assert.deepEqual(clashes, []);
});

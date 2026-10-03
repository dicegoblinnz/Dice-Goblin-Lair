// What Lair check-in keeps on the iPad, with a pretend POS storage: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadPending, readTileEntry, savePending, saveTileEntry } from '../extensions/lair-checkin/src/store.js';
import { PENDING_MS } from '../extensions/lair-checkin/src/split.js';

/** @param {{ broken?: boolean }} [options] */
function pretendStorage({ broken = false } = {}) {
  const saved = new Map();
  globalThis.shopify = /** @type {any} */ ({
    storage: {
      async get(key) {
        if (broken) throw new Error('RecordSize');
        return saved.get(key);
      },
      async set(key, value) {
        if (broken) throw new Error('RecordsCount');
        saved.set(key, JSON.parse(JSON.stringify(value)));
      },
    },
  });
  return saved;
}

afterEach(() => {
  delete globalThis.shopify;
});

test('keeps notes of shares and the tile’s numbers', async () => {
  const saved = pretendStorage();
  const now = 5 * PENDING_MS;
  await savePending({ 'booking:bk_sam': { ref: 'SJ-OWLBEAR-17', amount: 1000, expect: 1000, at: now - 1000 } });
  assert.deepEqual(await loadPending(now), { 'booking:bk_sam': { ref: 'SJ-OWLBEAR-17', amount: 1000, expect: 1000, at: now - 1000 } });
  assert.deepEqual(await loadPending(now + PENDING_MS), {}, 'old notes are dropped');
  await saveTileEntry({ at: 1, day: '2026-10-03', text: '14 today · 5 here' });
  assert.deepEqual(await readTileEntry(), { at: 1, day: '2026-10-03', text: '14 today · 5 here' });
  assert.equal(saved.size, 2);
});

test('storage that fails is shrugged off', async () => {
  pretendStorage({ broken: true });
  assert.deepEqual(await loadPending(1), {});
  await savePending({});
  await saveTileEntry({ at: 1, text: 'x' });
  assert.equal(await readTileEntry(), undefined);
  delete globalThis.shopify;
  assert.deepEqual(await loadPending(1), {}, 'no storage API at all');
});

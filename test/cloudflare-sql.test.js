// 29 Oct 2026: Cloudflare's SQLite limits, which every test file's stand-in SQL now checks (test/cloudflare-sql.js).
// Measured on the Lair's own D1 that night: a compound SELECT of 5 terms runs, one of 6 says "too many terms in compound
// SELECT", and 8 terms as two bracketed groups of 5 and 3 run. The stamps query (round 22) had 8 in one, so My Lair,
// the staff page's members and the counter's loyalty card failed in production until it was split. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COMPOUND_TERMS, cloudflareSql, compoundTerms } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';

const union = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i + 1} AS n`).join(' UNION ALL ');

test('compound SELECTs: 5 terms is the most Cloudflare runs; a bracketed SELECT counts on its own', () => {
  assert.equal(MAX_COMPOUND_TERMS, 5);
  assert.equal(compoundTerms('SELECT 1'), 1);
  assert.equal(compoundTerms(union(5)), 5);
  assert.equal(compoundTerms(union(6)), 6);
  assert.doesNotThrow(() => cloudflareSql(union(5), []));
  assert.throws(() => cloudflareSql(union(6), []), /too many terms in compound SELECT/);
  // as measured: two groups in brackets, of 5 and 3, are fine
  const split = `SELECT * FROM (SELECT * FROM (${union(5)}) UNION ALL SELECT * FROM (${union(3)})) ORDER BY n`;
  assert.equal(compoundTerms(split), 5);
  assert.doesNotThrow(() => cloudflareSql(split, []));
  // INTERSECT and EXCEPT are terms too; a word in a string or a comment isn't
  assert.equal(compoundTerms('SELECT 1 INTERSECT SELECT 1 EXCEPT SELECT 2'), 3);
  assert.equal(compoundTerms("SELECT 'a UNION b' -- UNION\n /* UNION */"), 1);
  // and bound values, as before
  assert.throws(() => cloudflareSql('SELECT 1', new Array(101).fill(1)), /too many SQL variables: 101/);
});

test("the stamps query keeps within Cloudflare's 5 terms (it had 8 in one compound SELECT)", () => {
  const lair = Object.create(Lair.prototype);
  Object.assign(lair, { loyaltyFrom: Date.UTC(2026, 9, 1), stampsUntil: () => Date.UTC(2026, 9, 29) });
  const { sql, binds } = lair.stampRowsQuery('9001', Date.UTC(2026, 9, 28));
  assert.ok(compoundTerms(sql) <= MAX_COMPOUND_TERMS, `${compoundTerms(sql)} terms`);
  assert.equal((sql.match(/\?/g) || []).length, binds.length, 'a value for every question mark');
});

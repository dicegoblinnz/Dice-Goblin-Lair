// Reading the codes staff scan or type (SJ-OWLBEAR-17, and the older GOB-7K2QXM): `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_WORDS, codeKey, readCode } from '../extensions/lair-checkin/src/codes.js';

const sam = { kind: 'code', code: 'SJ-OWLBEAR-17', key: 'SJOWLBEAR17', legacy: false };

test('reads fun codes however they are typed or scanned', () => {
  for (const raw of ['SJ-OWLBEAR-17', 'sj owlbear 17', 'SJOWLBEAR17', 'Sj-Owlbear-17', 'sj.owlbear_17', '  sj - owlbear - 17 \n', 'sjowlbear 17', 'SJ OWLBEAR 017']) {
    assert.deepEqual(readCode(raw), sam, raw);
  }
  assert.deepEqual(readCode('dg kiwi 3'), { kind: 'code', code: 'DG-KIWI-3', key: 'DGKIWI3', legacy: false });
  assert.deepEqual(readCode('ZB-LAMINGTON-99').code, 'ZB-LAMINGTON-99');
});

test('finds a code inside a link or longer text', () => {
  assert.deepEqual(readCode('https://www.dicegoblin.nz/pages/lair?code=SJ-OWLBEAR-17'), sam);
  assert.deepEqual(readCode('Ticket: SJ-OWLBEAR-17'), sam);
});

test('reads the older GOB codes, with or without the dash', () => {
  for (const raw of ['GOB-7K2QXM', 'gob7k2qxm', 'gob 7k2 qxm', 'Gob-7k2qxm']) {
    assert.deepEqual(readCode(raw), { kind: 'code', code: 'GOB-7K2QXM', key: 'GOB7K2QXM', legacy: true }, raw);
  }
});

test('a known word wins over an old GOB code that looks the same', () => {
  // GO-BADGER-5 and GOB-ADGER5 are both "GOBADGER5" once the dashes go.
  assert.deepEqual(readCode('gobadger5'), { kind: 'code', code: 'GO-BADGER-5', key: 'GOBADGER5', legacy: false });
});

test('a code with a word that is not on the list still goes to the Lair app', () => {
  assert.deepEqual(readCode('zz flumph 3'), { kind: 'code', code: 'ZZ-FLUMPH-3', key: 'ZZFLUMPH3', legacy: false });
});

test('every word on the list reads back', () => {
  for (const word of CODE_WORDS) {
    assert.equal(readCode(`ab ${word.toLowerCase()} 20`).kind === 'code' && readCode(`ab${word}20`).code, `AB-${word}-20`, word);
  }
});

test('turns away things that are not Lair codes', () => {
  assert.deepEqual(readCode('   '), { kind: 'empty' });
  assert.deepEqual(readCode(undefined), { kind: 'empty' });
  assert.equal(readCode('9421234567890').kind, 'unknown', 'a product barcode');
  assert.equal(readCode('Sam').kind, 'unknown');
  assert.equal(readCode('SJ-OWLBEAR').kind, 'unknown');
  assert.equal(readCode('SJ-OWLBEAR-0').kind, 'unknown');
  assert.equal(readCode('SJ-OWLBEAR-100').kind, 'unknown');
  assert.equal(readCode('SAM-4821').kind, 'unknown', 'round-3 codes never went live');
  assert.equal(readCode('DGC-12345').kind, 'unknown', 'round-3 member cards never went live');
});

test('the lookup key is letters and digits only', () => {
  assert.equal(codeKey('sj owlbear 17'), 'SJOWLBEAR17');
  assert.equal(codeKey('Sj-Owlbear-17'), 'SJOWLBEAR17');
  assert.equal(codeKey(null), '');
});

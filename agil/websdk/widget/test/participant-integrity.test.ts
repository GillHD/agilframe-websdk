/**
 * C-04/C-11 regression tests: a missing integrity verdict is “unknown”, not
 * “possible media spoofing”.
 *
 * The QA harness (and any older payload) simply omits `integrity`, so the old
 * renderer painted a red „Возможна подмена видео или звука” triangle on every
 * participant. Only an explicit `'suspicious'` may raise that alarm now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrityBadge, normalizeIntegrity } from '../src/ui/participant-integrity.js';

test('missing, null and malformed integrity fall back to unknown', () => {
  for (const value of [undefined, null, '', 'verified ', 'SUSPICIOUS', 1, {}, []]) {
    assert.equal(normalizeIntegrity(value), 'unknown', `${JSON.stringify(value)} should be unknown`);
  }
});

test('explicit verdicts survive normalisation', () => {
  assert.equal(normalizeIntegrity('unknown'), 'unknown');
  assert.equal(normalizeIntegrity('verified'), 'verified');
  assert.equal(normalizeIntegrity('suspicious'), 'suspicious');
});

test('unknown integrity renders no badge at all', () => {
  assert.equal(integrityBadge(undefined, false), 'none');
  assert.equal(integrityBadge('unknown', false), 'none');
  assert.equal(integrityBadge(null, false), 'none');
});

test('only an explicit suspicious verdict is an alarm', () => {
  assert.equal(integrityBadge('suspicious', false), 'suspicious');
  // A verified identity wins over an unknown/missing media verdict…
  assert.equal(integrityBadge(undefined, true), 'verified');
  assert.equal(integrityBadge('verified', false), 'verified');
});

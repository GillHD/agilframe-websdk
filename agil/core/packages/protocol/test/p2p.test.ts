/** Explicit direct-room transport contract (docs/p2p.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomTransportSchema } from '../src/signaling.js';

test('room transport accepts only p2p | sfu', () => {
  assert.equal(roomTransportSchema.parse('p2p'), 'p2p');
  assert.equal(roomTransportSchema.parse('sfu'), 'sfu');
  assert.equal(roomTransportSchema.safeParse('mesh').success, false);
  assert.equal(roomTransportSchema.safeParse(undefined).success, false);
});

test('omitted transport is a valid create-room request (current behaviour)', () => {
  // The request field is optional; only an explicitly invalid value fails.
  assert.equal(roomTransportSchema.optional().parse(undefined), undefined);
});

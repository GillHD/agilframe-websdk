import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTokenUnsafe, signToken, verifyToken } from '../src/token.js';

const SECRET = 'test-secret';
const claims = {
  sub: 'user-1',
  name: 'Анна',
  role: 'host' as const,
  tenantId: 'acme',
  roomId: 'room-1',
};

test('signs and verifies a token', () => {
  const token = signToken(claims, SECRET);
  const result = verifyToken(token, SECRET);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.claims.sub, 'user-1');
    assert.equal(result.claims.roomId, 'room-1');
    assert.equal(result.claims.role, 'host');
    assert.ok(result.claims.exp > result.claims.iat);
  }
});

test('rejects bad signature', () => {
  const token = signToken(claims, SECRET);
  const result = verifyToken(token, 'other-secret');
  assert.deepEqual(result, { valid: false, error: 'bad_signature' });
});

test('rejects expired token', () => {
  const token = signToken(claims, SECRET, { ttlSec: 10, now: 1000 });
  const result = verifyToken(token, SECRET, { now: 1020, clockToleranceSec: 0 });
  assert.deepEqual(result, { valid: false, error: 'expired' });
  const ok = verifyToken(token, SECRET, { now: 1005, clockToleranceSec: 0 });
  assert.equal(ok.valid, true);
});

test('rejects malformed tokens', () => {
  assert.deepEqual(verifyToken('', SECRET), { valid: false, error: 'missing_token' });
  assert.deepEqual(verifyToken('a.b', SECRET), { valid: false, error: 'malformed_token' });
  assert.deepEqual(verifyToken('a.b.c', SECRET), { valid: false, error: 'malformed_payload' });
});

test('rejects tampered payload', () => {
  const token = signToken(claims, SECRET);
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, role: 'moderator', iat: 1, exp: 9999999999 })).toString(
    'base64url',
  );
  const result = verifyToken(`${header}.${forged}.${signature}`, SECRET);
  assert.deepEqual(result, { valid: false, error: 'bad_signature' });
});

test('decodeTokenUnsafe reads claims without verification', () => {
  const token = signToken(claims, SECRET);
  const decoded = decodeTokenUnsafe(token);
  assert.equal(decoded?.tenantId, 'acme');
  assert.equal(decodeTokenUnsafe('garbage'), null);
});

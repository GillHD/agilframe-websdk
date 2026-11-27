import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedOrigin,
  parseAllowedOrigins,
  parseOrigin,
  tryParseOrigin,
} from '../src/origin.js';
import { EmbedConfigError } from '../src/errors.js';

const WIDGET = 'https://calls.example.com';

test('parseOrigin: canonicalizes host case and default ports', () => {
  assert.equal(parseOrigin('HTTPS://Calls.Example.COM/'), 'https://calls.example.com');
  assert.equal(parseOrigin('https://calls.example.com:443/'), 'https://calls.example.com');
  assert.equal(parseOrigin('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(parseOrigin('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173');
});

test('parseOrigin: rejects wildcards, paths, queries, fragments and credentials', () => {
  for (const origin of [
    '*',
    'https://*.example.com',
    'https://calls.example.com/path',
    'https://calls.example.com/?x=1',
    'https://calls.example.com/#frag',
    'https://user:pass@calls.example.com',
    'javascript:alert(1)',
    'file:///tmp',
    'not a url',
    '',
  ]) {
    assert.throws(() => parseOrigin(origin), EmbedConfigError, `should reject ${origin}`);
  }
});

test('parseAllowedOrigins: always includes the iframe origin and dedupes', () => {
  const allowed = parseAllowedOrigins(
    'https://Alt.Example.com/, https://calls.example.com, https://alt.example.com:443',
    WIDGET,
  );
  assert.deepEqual(allowed, ['https://calls.example.com', 'https://alt.example.com']);
  assert.ok(Object.isFrozen(allowed));
});

test('parseAllowedOrigins: empty attribute means iframe origin only', () => {
  assert.deepEqual(parseAllowedOrigins(null, WIDGET), [WIDGET]);
  assert.deepEqual(parseAllowedOrigins('   ', WIDGET), [WIDGET]);
  assert.deepEqual(parseAllowedOrigins(undefined, WIDGET), [WIDGET]);
});

test('parseAllowedOrigins: rejects wildcard and malformed entries', () => {
  assert.throws(() => parseAllowedOrigins('*', WIDGET), /wildcards are not allowed/);
  assert.throws(
    () => parseAllowedOrigins('https://*.example.com', WIDGET),
    /wildcards are not allowed/,
  );
  assert.throws(() => parseAllowedOrigins('https://alt.example.com/path', WIDGET), /without path/);
  assert.throws(
    () => parseAllowedOrigins(Array.from({ length: 33 }, (_, i) => `https://a${i}.example.com`).join(','), WIDGET),
    /too many entries/,
  );
});

test('parseAllowedOrigins: caps the total size including the iframe origin', () => {
  const entries = Array.from({ length: 32 }, (_, index) => `https://a${index}.example.com`).join(',');
  assert.throws(() => parseAllowedOrigins(entries, WIDGET), /too many entries/);
});

test('isAllowedOrigin: exact matches only (no prefix/suffix surprises)', () => {
  const allowed = parseAllowedOrigins('https://alt.example.com', WIDGET);
  assert.equal(isAllowedOrigin(WIDGET, allowed), true);
  assert.equal(isAllowedOrigin('https://alt.example.com', allowed), true);
  assert.equal(isAllowedOrigin('https://calls.example.com.evil', allowed), false);
  assert.equal(isAllowedOrigin('https://evil-calls.example.com', allowed), false);
  assert.equal(isAllowedOrigin('http://calls.example.com', allowed), false);
  assert.equal(isAllowedOrigin('https://calls.example.com:444', allowed), false);
  assert.equal(isAllowedOrigin('null', allowed), false);
  assert.equal(isAllowedOrigin('', allowed), false);
  assert.equal(isAllowedOrigin('https://calls.example.com/path', allowed), false);
});

test('isAllowedOrigin: empty allowlist rejects everything', () => {
  assert.equal(isAllowedOrigin(WIDGET, []), false);
});

test('tryParseOrigin: non-throwing helper', () => {
  assert.equal(tryParseOrigin(WIDGET), WIDGET);
  assert.equal(tryParseOrigin('*'), null);
});

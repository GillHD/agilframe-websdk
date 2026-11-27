import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmbedUrl,
  normalizeServerUrl,
  resolveWidgetUrl,
} from '../src/url.js';
import { EmbedConfigError } from '../src/errors.js';

const SERVER = 'https://calls.example.com';

test('buildEmbedUrl: canonical URL, encoding and all supported parameters', () => {
  const target = buildEmbedUrl({
    serverUrl: `${SERVER}/`,
    room: 'team sync / #1',
    token: 'header.payload.signature',
    identityToken: 'oidc-token',
    role: 'guest',
    tenant: 'acme',
    name: 'Анна & Co',
    theme: 'dark',
    language: 'ru',
    relayOnly: true,
  });

  assert.equal(target.origin, SERVER);
  assert.equal(target.serverUrl, SERVER);
  const url = new URL(target.url);
  assert.equal(url.origin, SERVER);
  assert.equal(url.pathname, '/embed.html');
  assert.equal(url.searchParams.get('server'), SERVER);
  assert.equal(url.searchParams.get('room'), 'team sync / #1');
  assert.equal(url.searchParams.get('token'), 'header.payload.signature');
  assert.equal(url.searchParams.get('identity_token'), 'oidc-token');
  assert.equal(url.searchParams.get('role'), 'guest');
  assert.equal(url.searchParams.get('tenant'), 'acme');
  assert.equal(url.searchParams.get('name'), 'Анна & Co');
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('lang'), 'ru');
  assert.equal(url.searchParams.get('relay'), '1');
  assert.equal(url.hash, '');
});

test('buildEmbedUrl: optional parameters are omitted, not sent empty', () => {
  const target = buildEmbedUrl({ serverUrl: SERVER, room: 'room-1' });
  const url = new URL(target.url);
  assert.equal(url.searchParams.get('room'), 'room-1');
  for (const key of ['token', 'identity_token', 'role', 'tenant', 'name', 'theme', 'lang', 'relay']) {
    assert.equal(url.searchParams.has(key), false, `${key} should be absent`);
  }
});

test('buildEmbedUrl: the default widget path preserves a server subpath', () => {
  const target = buildEmbedUrl({ serverUrl: 'https://calls.example.com/calls', room: 'r1' });
  assert.equal(new URL(target.url).pathname, '/calls/embed.html');
  assert.equal(target.serverUrl, 'https://calls.example.com/calls');
});

test('buildEmbedUrl: widget-path resolves relative to a server path prefix', () => {
  const target = buildEmbedUrl({
    serverUrl: 'https://calls.example.com/base/',
    widgetPath: 'embed.html',
    room: 'r1',
  });
  assert.equal(new URL(target.url).pathname, '/base/embed.html');
  assert.equal(target.serverUrl, 'https://calls.example.com/base');
  assert.equal(new URL(target.url).searchParams.get('server'), target.serverUrl);
});

test('buildEmbedUrl: absolute widget path stays on the server origin', () => {
  const target = buildEmbedUrl({
    serverUrl: SERVER,
    widgetPath: '/widget/embed.html',
    room: 'r1',
  });
  assert.equal(new URL(target.url).pathname, '/widget/embed.html');
});

test('normalizeServerUrl: strips trailing slashes and preserves a base path', () => {
  assert.equal(normalizeServerUrl('https://calls.example.com///'), 'https://calls.example.com');
  assert.equal(normalizeServerUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(normalizeServerUrl('https://calls.example.com/app/'), 'https://calls.example.com/app');
});

test('resolveWidgetUrl: rejects widget paths that leave the server origin', () => {
  assert.throws(
    () => resolveWidgetUrl(SERVER, 'https://evil.example/embed.html'),
    /path on the configured server/,
  );
  assert.throws(() => resolveWidgetUrl(SERVER, '//evil.example/embed.html'), /path on the configured server/);
  assert.throws(() => resolveWidgetUrl(SERVER, '../embed.html'), /\.\./);
  assert.throws(() => resolveWidgetUrl(SERVER, '/embed.html?x=1'), /query or fragment/);
  assert.throws(() => resolveWidgetUrl(SERVER, '\\embed.html'), /forward slashes/);
});

test('buildEmbedUrl: rejects non-http(s) servers and credential URLs', () => {
  for (const serverUrl of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://calls.example.com',
    'https://user:pass@calls.example.com',
    'https://calls.example.com/?token=secret',
    'https://calls.example.com/#fragment',
    '/relative',
    'calls.example.com',
  ]) {
    assert.throws(
      () => buildEmbedUrl({ serverUrl, room: 'r1' }),
      EmbedConfigError,
      `server-url should be rejected: ${serverUrl}`,
    );
  }
});

test('buildEmbedUrl: server-url is required without a browser origin', () => {
  assert.equal(typeof globalThis.location, 'undefined');
  assert.throws(() => buildEmbedUrl({ room: 'r1' }), /server-url is required/);
});

test('buildEmbedUrl: room is required and control characters are rejected', () => {
  assert.throws(() => buildEmbedUrl({ serverUrl: SERVER, room: '' }), /room is required/);
  assert.throws(() => buildEmbedUrl({ serverUrl: SERVER, room: '   ' }), /room is required/);
  assert.throws(() => buildEmbedUrl({ serverUrl: SERVER, room: 'room\u0000x' }), /control characters/);
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r'.repeat(201) }),
    /room is too long/,
  );
});

test('buildEmbedUrl: theme and language are validated', () => {
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r', theme: 'corporate' as never }),
    /theme must be/,
  );
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r', language: 'en US' }),
    /BCP-47/,
  );
  const ok = buildEmbedUrl({ serverUrl: SERVER, room: 'r', language: 'en-US', theme: 'auto' });
  assert.equal(new URL(ok.url).searchParams.get('lang'), 'en-US');
  assert.equal(new URL(ok.url).searchParams.get('theme'), 'auto');
});

test('buildEmbedUrl: errors never echo the token or the rejected URL', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  try {
    buildEmbedUrl({
      serverUrl: SERVER,
      widgetPath: '/embed.html?token=' + token,
      room: 'r',
      token,
    });
    assert.fail('expected a configuration error');
  } catch (error) {
    assert.ok(error instanceof EmbedConfigError);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes('signature'), false);
  }
});

test('buildEmbedUrl: rejects public http unless allowInsecure is set', () => {
  assert.throws(
    () => buildEmbedUrl({ serverUrl: 'http://calls.example.com', room: 'r1' }),
    /must use https/,
  );
  assert.ok(
    buildEmbedUrl({ serverUrl: 'http://localhost:8787', room: 'r1' }).url.startsWith(
      'http://localhost:8787/embed.html?',
    ),
  );
  assert.ok(
    buildEmbedUrl({
      serverUrl: 'http://calls.example.com',
      room: 'r1',
      allowInsecure: true,
    }).url.startsWith('http://calls.example.com/embed.html?'),
  );
});

test('buildEmbedUrl: validates identity token and role', () => {
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r1', identityToken: 'id token' }),
    /identityToken must not contain whitespace/,
  );
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r1', role: 'admin' as never }),
    /role must be/,
  );
});

test('buildEmbedUrl: token length and control characters are bounded', () => {
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r', token: 't'.repeat(8193) }),
    /token is too long/,
  );
  assert.throws(
    () => buildEmbedUrl({ serverUrl: SERVER, room: 'r', token: 'a\nb' }),
    /control characters/,
  );
});

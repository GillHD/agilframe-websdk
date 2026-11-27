/**
 * Localization contract for widget-internal errors.
 *
 * Media/signaling failures carry a machine `code` (for hosts) and an i18n
 * `messageKey` (for the UI). This test pins both dictionaries, forbids Cyrillic
 * in English copy, and makes sure raw codes/technical messages never reach the
 * user-facing strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18n } from '../src/i18n.js';
import { MEDIA_ERROR_KEYS, MediaAccessError, mapMediaError } from '../src/call/media.js';
import { SIGNALING_ERROR_KEYS, SignalingError } from '../src/call/signaling-client.js';

const CYRILLIC = /[\u0400-\u04FF]/;
const RAW_CODE = /\b(permission_denied|not_found|in_use|constraints|unsupported|unknown|connection_closed|reconnect_exhausted|server_timeout|socket_failed|network_error|internal_error)\b/;

const LOCALES = ['ru', 'en'] as const;

for (const locale of LOCALES) {
  test(`media error keys are localized and code-free (${locale})`, () => {
    const i18n = new I18n(locale);
    for (const [code, key] of Object.entries(MEDIA_ERROR_KEYS)) {
      const text = i18n.t(key);
      assert.ok(text.length > 0, `${code}: empty copy`);
      assert.notEqual(text, key, `${code}: dictionary key leaked as text`);
      assert.ok(!RAW_CODE.test(text), `${code}: raw code leaked into copy: ${text}`);
      if (locale === 'en') assert.ok(!CYRILLIC.test(text), `${code}: Cyrillic in English copy: ${text}`);
    }
  });

  test(`signaling error keys are localized and code-free (${locale})`, () => {
    const i18n = new I18n(locale);
    for (const [code, key] of Object.entries(SIGNALING_ERROR_KEYS)) {
      const text = i18n.t(key);
      assert.ok(text.length > 0, `${code}: empty copy`);
      assert.notEqual(text, key, `${code}: dictionary key leaked as text`);
      assert.ok(!RAW_CODE.test(text), `${code}: raw code leaked into copy: ${text}`);
      if (locale === 'en') assert.ok(!CYRILLIC.test(text), `${code}: Cyrillic in English copy: ${text}`);
    }
  });
}

test('MediaAccessError keeps the host-visible code and a localizable key', () => {
  const error = new MediaAccessError('not_found', 'no audio track in getUserMedia result', 'mediaMicrophoneUnavailable');
  assert.equal(error.code, 'not_found');
  assert.equal(error.messageKey, 'mediaMicrophoneUnavailable');
  assert.equal(new I18n('ru').t(error.messageKey), 'Не удалось получить звук с микрофона. Проверьте устройство и разрешения браузера.');
  assert.ok(!CYRILLIC.test(error.message), 'internal message must stay technical English');
});

test('mapMediaError normalizes DOM failures without localized internals', () => {
  const denied = new Error('Permission denied by user');
  denied.name = 'NotAllowedError';
  const mapped = mapMediaError(denied);
  assert.equal(mapped.code, 'permission_denied');
  assert.equal(mapped.messageKey, 'mediaPermissionDenied');
  assert.equal(mapped.message, 'Permission denied by user');
  assert.ok(!CYRILLIC.test(mapped.message));

  const en = new I18n('en').t(mapped.messageKey);
  assert.match(en, /camera or microphone/i);

  const busy = mapMediaError(Object.assign(new Error('Device in use'), { name: 'NotReadableError' }));
  assert.equal(busy.code, 'in_use');
  assert.equal(busy.messageKey, 'mediaDeviceBusy');
});

test('SignalingError exposes a stable code and technical message', () => {
  const error = new SignalingError('reconnect_exhausted', 'reconnect attempts exhausted');
  assert.equal(error.code, 'reconnect_exhausted');
  assert.equal(error.messageKey, 'reconnectExhausted');
  assert.equal(new I18n('en').t(error.messageKey), 'Could not reconnect. Check your network and join again.');
  assert.ok(!CYRILLIC.test(error.message));

  const closed = new SignalingError('connection_closed', 'connection closed before welcome');
  assert.equal(closed.code, 'connection_closed');
  assert.equal(closed.messageKey, 'connectionClosed');
});

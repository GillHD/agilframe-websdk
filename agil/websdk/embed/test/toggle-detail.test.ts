import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fullscreenDetail, minimizedDetail } from '../src/element.js';

// The iframe sends `{type:'agil:minimized', minimized}` / `{...fullscreen}`.
// The DOM event detail must use the same `{minimized}` / `{fullscreen}` keys as
// React Native/Flutter/Capacitor, not the old shared `{value}` shape.
test('agil-minimized detail uses { minimized } like the mobile SDKs', () => {
  assert.deepEqual(minimizedDetail(true), { minimized: true });
  assert.deepEqual(minimizedDetail(false), { minimized: false });
  assert.equal(Object.prototype.hasOwnProperty.call(minimizedDetail(true), 'value'), false);
});

test('agil-fullscreen detail uses { fullscreen } like the mobile SDKs', () => {
  assert.deepEqual(fullscreenDetail(true), { fullscreen: true });
  assert.deepEqual(fullscreenDetail(false), { fullscreen: false });
  assert.equal(Object.prototype.hasOwnProperty.call(fullscreenDetail(false), 'value'), false);
});

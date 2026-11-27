/**
 * Embedded desktop chrome policy tests (embedded call).
 *
 * The rule is intentionally narrow: only an embedded, chrome-less widget with a
 * fine pointer and desktop room gets the header switch + rectangular dock.
 * Everything else — the default full-chrome widget, touch phones and narrow
 * embeds — keeps the existing layout byte-for-byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDED_DESKTOP_MIN_HOST,
  EMBEDDED_DESKTOP_MIN_VIEWPORT,
  isEmbeddedDesktopChrome,
  resolveCallChrome,
  type EmbeddedChromeInput,
} from '../src/ui/call-chrome.js';
import { resolveControlsStyle } from '../src/ui/controls-density.js';

const base: EmbeddedChromeInput = {
  embedded: true,
  chrome: 'none',
  pointerFine: true,
  viewportWidth: 1440,
  hostWidth: 648,
};

test('embedded chrome-less desktop activates the desktop call chrome', () => {
  assert.equal(resolveCallChrome(base), 'embedded-desktop');
  assert.equal(isEmbeddedDesktopChrome(base), true);
});

test('the embedded call card (~648px) is desktop even inside a 1440px page', () => {
  // This is the exact complaint: a wide page with a half-width call card.
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 1440, hostWidth: 648 }), 'embedded-desktop');
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 1024, hostWidth: 648 }), 'embedded-desktop');
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 680, hostWidth: 680 }), 'embedded-desktop');
});

test('the host-width floor is 600px and the viewport floor is 760px', () => {
  assert.equal(EMBEDDED_DESKTOP_MIN_HOST, 600);
  assert.equal(EMBEDDED_DESKTOP_MIN_VIEWPORT, 760);
  // Narrow desktop window: viewport <760 and host <600 → keep mobile layout.
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 390, hostWidth: 390 }), 'default');
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 599, hostWidth: 599 }), 'default');
  // A wide viewport still qualifies even if the host measurement is missing.
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 1440, hostWidth: 0 }), 'embedded-desktop');
  // 600 px host is enough.
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 600, hostWidth: 600 }), 'embedded-desktop');
});

test('touch devices keep the 44px island even on a wide screen', () => {
  assert.equal(resolveCallChrome({ ...base, pointerFine: false, viewportWidth: 1440, hostWidth: 648 }), 'default');
  assert.equal(isEmbeddedDesktopChrome({ ...base, pointerFine: false }), false);
});

test('default full-chrome widget and non-embedded hosts are unchanged', () => {
  assert.equal(resolveCallChrome({ ...base, chrome: 'full' }), 'default');
  assert.equal(resolveCallChrome({ ...base, chrome: 'compact' }), 'default');
  assert.equal(resolveCallChrome({ ...base, embedded: false }), 'default');
});

test('invalid measurements never crash and never enable the mode', () => {
  assert.equal(resolveCallChrome({ ...base, viewportWidth: Number.NaN, hostWidth: Number.NaN }), 'default');
  assert.equal(resolveCallChrome({ ...base, viewportWidth: 0, hostWidth: 0 }), 'default');
});

test('the embedded desktop style is the rectangular dock, not the island', () => {
  assert.equal(resolveControlsStyle('island', false, true), 'dock');
  assert.equal(resolveControlsStyle('bar', false, true), 'dock');
  assert.equal(resolveControlsStyle('minimal', false, true), 'dock');
  // Without the embedded desktop flag the pre-existing rules still hold.
  assert.equal(resolveControlsStyle('island', false, false), 'island');
  assert.equal(resolveControlsStyle('bar', true, false), 'island');
  assert.equal(resolveControlsStyle('bar', false, false), 'bar');
});

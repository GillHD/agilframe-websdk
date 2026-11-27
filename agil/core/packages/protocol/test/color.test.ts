import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestTextColor,
  contrastRatio,
  generatePalette,
  hexToRgb,
  mix,
  normalizeHex,
  relativeLuminance,
  rgbToHex,
  withAlpha,
} from '../src/color.js';

test('normalizeHex accepts short/long/with-hash', () => {
  assert.equal(normalizeHex('#abc'), '#aabbcc');
  assert.equal(normalizeHex('0B5FFF'), '#0b5fff');
  assert.equal(normalizeHex('#11223344'), '#112233');
  assert.throws(() => normalizeHex('blue'));
});

test('hexToRgb / rgbToHex roundtrip', () => {
  assert.deepEqual(hexToRgb('#0b5fff'), { r: 11, g: 95, b: 255 });
  assert.equal(rgbToHex({ r: 11, g: 95, b: 255 }), '#0b5fff');
});

test('contrastRatio is symmetric and WCAG-correct', () => {
  assert.equal(contrastRatio('#ffffff', '#000000').toFixed(2), '21.00');
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#777777', '#777777').toFixed(2), '1.00');
  assert.ok(contrastRatio('#ffffff', '#0b5fff') > 4);
});

test('relativeLuminance monotonic', () => {
  assert.ok(relativeLuminance('#ffffff') > relativeLuminance('#808080'));
  assert.ok(relativeLuminance('#808080') > relativeLuminance('#000000'));
});

test('mix interpolates', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
});

test('withAlpha appends alpha byte', () => {
  assert.equal(withAlpha('#0b5fff', 1), '#0b5fff' + 'ff');
  assert.equal(withAlpha('#0b5fff', 0.5), '#0b5fff80');
});

test('bestTextColor picks readable text', () => {
  assert.equal(bestTextColor('#ffffff'), '#000000');
  assert.equal(bestTextColor('#000000'), '#ffffff');
});

test('generatePalette keeps brand primary and readable onPrimary', () => {
  const palette = generatePalette('#0b5fff', 'light');
  assert.equal(palette.primary, '#0b5fff');
  assert.ok(contrastRatio(palette.onPrimary, palette.primary) >= 4.5);
  assert.ok(palette.primaryHover !== palette.primary);
  assert.match(palette.focusRing, /^#[0-9a-f]{8}$/);
  const dark = generatePalette('#0b5fff', 'dark');
  assert.notEqual(dark.primaryHover, palette.primaryHover);
});

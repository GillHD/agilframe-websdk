import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBrandColor,
  auditTheme,
  cssVarsToString,
  deepMerge,
  effectiveScheme,
  resolveTheme,
  themeFromBrandColor,
  themePresetNames,
  themePresets,
  toCssVars,
} from '../src/theme.js';
import { contrastRatio } from '../src/color.js';

test('all presets resolve and validate', () => {
  for (const name of themePresetNames) {
    const theme = resolveTheme(themePresets[name], name === 'dark' || name === 'night' ? 'dark' : 'light');
    assert.equal(typeof theme.colors.primary, 'string');
    assert.ok(theme.typography.fontFamily.includes('Inter'));
  }
});

test('resolveTheme merges partial patch, keeps rest', () => {
  const theme = resolveTheme({ colors: { primary: '#ff0000' } } as never, 'light');
  assert.equal(theme.colors.primary, '#ff0000');
  assert.ok(theme.colors.text.length > 0);
  assert.equal(theme.scheme, 'light');
});

test('resolveTheme auto scheme returns auto', () => {
  const theme = resolveTheme({}, 'auto');
  assert.equal(theme.scheme, 'auto');
  assert.equal(effectiveScheme(theme, true), 'dark');
  assert.equal(effectiveScheme(theme, false), 'light');
});

test('deepMerge replaces arrays and primitives', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, list: [1, 2] };
  const merged = deepMerge(base, { b: { c: 9 }, list: [3] });
  assert.deepEqual(merged, { a: 1, b: { c: 9, d: 3 }, list: [3] });
});

test('toCssVars exposes every color token and core vars', () => {
  const theme = themePresets.light;
  const vars = toCssVars(theme);
  assert.equal(vars['--agil-color-primary'], theme.colors.primary);
  assert.equal(vars['--agil-radius-md'], `${theme.shape.radiusMd}px`);
  assert.ok(vars['--agil-font-family']);
  assert.ok(vars['--agil-bg-gradient']);
  assert.ok(vars['--agil-logo-height']);
  const css = cssVarsToString(vars);
  assert.ok(css.includes('--agil-color-background:'));
  assert.ok(css.split('\n').length > 40);
});

test('applyBrandColor rebuilds primary family with readable text', () => {
  const theme = applyBrandColor(themePresets.light, '#e11d48');
  assert.equal(theme.colors.primary, '#e11d48');
  assert.ok(contrastRatio(theme.colors.onPrimary, theme.colors.primary) >= 4.5);
  assert.notEqual(theme.colors.primaryHover, theme.colors.primary);
});

test('themeFromBrandColor works for every preset', () => {
  for (const preset of themePresetNames) {
    const theme = themeFromBrandColor('#0ea5e9', preset);
    assert.equal(theme.colors.primary, '#0ea5e9');
  }
});

test('auditTheme reports unreadable text', () => {
  const theme = resolveTheme({} as never, 'light');
  theme.colors.text = theme.colors.background;
  const issues = auditTheme(theme);
  assert.ok(issues.some((issue) => issue.code === 'text-on-background' && issue.level === 'error'));
  const clean = auditTheme(themePresets.light);
  assert.equal(clean.filter((issue) => issue.level === 'error').length, 0);
});

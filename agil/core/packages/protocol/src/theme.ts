/**
 * AgilFrame design tokens.
 *
 * The whole embeddable UI is driven by these tokens: corporate clients can
 * re-skin it per tenant (or per embed) without touching the widget code.
 * Tokens are serializable JSON, validated by zod, and can be produced either
 * by hand, by the visual editor, or by an LLM through the MCP server.
 */
import { z } from 'zod';
import { deepPartialObject } from './patch-schema.js';
import {
  bestTextColor,
  contrastRatio,
  generatePalette,
  mix,
  normalizeHex,
  type Scheme,
} from './color.js';

const colorSchema = z
  .string()
  .min(3)
  .max(9)
  .refine((value) => /^#?[0-9a-f]{3,8}$/i.test(value), 'Expected a hex color like #1a73e8');

export const themeSchema = z.object({
  scheme: z.enum(['light', 'dark', 'auto']).default('auto'),
  colors: z.object({
    primary: colorSchema,
    primaryHover: colorSchema,
    primaryActive: colorSchema,
    onPrimary: colorSchema,
    accent: colorSchema,
    onAccent: colorSchema,
    background: colorSchema,
    backgroundAlt: colorSchema,
    surface: colorSchema,
    surfaceElevated: colorSchema,
    tileBg: colorSchema,
    tileBorder: colorSchema,
    text: colorSchema,
    textSecondary: colorSchema,
    textMuted: colorSchema,
    onSurface: colorSchema,
    border: colorSchema,
    divider: colorSchema,
    success: colorSchema,
    warning: colorSchema,
    danger: colorSchema,
    info: colorSchema,
    online: colorSchema,
    chatIncomingBg: colorSchema,
    chatOutgoingBg: colorSchema,
    chatIncomingText: colorSchema,
    chatOutgoingText: colorSchema,
    controlBg: colorSchema,
    controlHover: colorSchema,
    controlActive: colorSchema,
    controlText: colorSchema,
    controlDangerBg: colorSchema,
    focusRing: colorSchema,
    overlay: colorSchema,
    speakingRing: colorSchema,
    shadow: colorSchema,
  }),
  typography: z.object({
    fontFamily: z.string().min(1),
    fontFamilyMono: z.string().min(1),
    fontSizeBase: z.number().int().min(11).max(20),
    weightRegular: z.number().int().min(300).max(500),
    weightMedium: z.number().int().min(400).max(600),
    weightBold: z.number().int().min(500).max(900),
    lineHeight: z.number().min(1).max(1.8),
    headingWeight: z.number().int().min(400).max(900),
    letterSpacing: z.number().min(-0.05).max(0.1),
  }),
  shape: z.object({
    radiusSm: z.number().int().min(0).max(40),
    radiusMd: z.number().int().min(0).max(48),
    radiusLg: z.number().int().min(0).max(64),
    radiusPill: z.number().int().min(0).max(999),
    shadowSm: z.string(),
    shadowMd: z.string(),
    backdropBlurPx: z.number().int().min(0).max(40),
  }),
  spacing: z.object({
    density: z.enum(['compact', 'comfortable', 'spacious']),
    gutter: z.number().int().min(4).max(40),
    controlSize: z.number().int().min(32).max(72),
    controlGap: z.number().int().min(2).max(32),
  }),
  background: z.object({
    type: z.enum(['solid', 'gradient', 'image']),
    color: colorSchema,
    gradient: z.string(),
    imageUrl: z.string(),
    imagePosition: z.enum(['center', 'top', 'bottom', 'cover']),
    overlayOpacity: z.number().min(0).max(1),
  }),
  logo: z.object({
    url: z.string(),
    alt: z.string(),
    heightPx: z.number().int().min(12).max(96),
    position: z.enum(['header-left', 'header-center', 'watermark']),
  }),
  motion: z.object({
    speed: z.enum(['none', 'fast', 'normal']),
    durationFastMs: z.number().int().min(0).max(600),
    durationBaseMs: z.number().int().min(0).max(1000),
    easing: z.string().min(1),
  }),
});

export const themePatchSchema = deepPartialObject(themeSchema);

export type ThemeTokens = z.output<typeof themeSchema>;
export type ThemePatch = z.input<typeof themePatchSchema> | ThemeTokens;
export type ColorTokens = ThemeTokens['colors'];
export type ThemeScheme = 'light' | 'dark' | 'auto';

export const themeColorKeys = Object.keys(themeSchema.shape.colors.shape) as Array<keyof ColorTokens>;
export const themePresetNames = ['light', 'dark', 'corporate', 'night', 'minimal'] as const;
export type ThemePresetName = (typeof themePresetNames)[number];

const LIGHT_COLORS: ColorTokens = {
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  primaryActive: '#1e40af',
  onPrimary: '#ffffff',
  accent: '#0d9488',
  onAccent: '#ffffff',
  background: '#f3f6fb',
  backgroundAlt: '#e8edf6',
  surface: '#ffffff',
  surfaceElevated: '#ffffff',
  tileBg: '#0f172a',
  tileBorder: '#0b1220',
  text: '#0f172a',
  textSecondary: '#475569',
  textMuted: '#64748b',
  onSurface: '#0f172a',
  border: '#d5dde9',
  divider: '#e2e8f0',
  success: '#15803d',
  warning: '#b45309',
  danger: '#dc2626',
  info: '#0369a1',
  online: '#16a34a',
  chatIncomingBg: '#ffffff',
  chatOutgoingBg: '#dbeafe',
  chatIncomingText: '#0f172a',
  chatOutgoingText: '#0f172a',
  controlBg: '#ffffff',
  controlHover: '#eef2f9',
  controlActive: '#dde5f1',
  controlText: '#0f172a',
  controlDangerBg: '#dc2626',
  focusRing: '#2563eb99',
  overlay: '#0b1220cc',
  speakingRing: '#2563eb',
  shadow: '#0f172a26',
};

const DARK_COLORS: ColorTokens = {
  primary: '#3b82f6',
  primaryHover: '#60a5fa',
  primaryActive: '#93c5fd',
  onPrimary: '#06121f',
  accent: '#22d3ee',
  onAccent: '#04141a',
  background: '#080d16',
  backgroundAlt: '#0d1422',
  surface: '#111a2b',
  surfaceElevated: '#172136',
  tileBg: '#050a12',
  tileBorder: '#1d2a40',
  text: '#f1f5f9',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  onSurface: '#f1f5f9',
  border: '#293547',
  divider: '#1e293b',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#f87171',
  info: '#38bdf8',
  online: '#22c55e',
  chatIncomingBg: '#172136',
  chatOutgoingBg: '#1e3a8a',
  chatIncomingText: '#f1f5f9',
  chatOutgoingText: '#eff6ff',
  controlBg: '#172136',
  controlHover: '#22304a',
  controlActive: '#2b3b58',
  controlText: '#f1f5f9',
  controlDangerBg: '#dc2626',
  focusRing: '#60a5fa99',
  overlay: '#020610cc',
  speakingRing: '#60a5fa',
  shadow: '#00000066',
};

const BASE_TYPOGRAPHY: ThemeTokens['typography'] = {
  fontFamily:
    "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  fontFamilyMono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  fontSizeBase: 14,
  weightRegular: 400,
  weightMedium: 500,
  weightBold: 700,
  lineHeight: 1.45,
  headingWeight: 650,
  letterSpacing: 0,
};

const BASE_SHAPE: ThemeTokens['shape'] = {
  radiusSm: 6,
  radiusMd: 12,
  radiusLg: 20,
  radiusPill: 999,
  shadowSm: '0 1px 2px rgba(15, 23, 42, 0.12)',
  shadowMd: '0 12px 32px rgba(15, 23, 42, 0.24)',
  backdropBlurPx: 14,
};

const BASE_SPACING: ThemeTokens['spacing'] = {
  density: 'comfortable',
  gutter: 16,
  controlSize: 48,
  controlGap: 10,
};

const BASE_BACKGROUND: ThemeTokens['background'] = {
  type: 'gradient',
  color: '#f3f6fb',
  gradient: 'linear-gradient(160deg, #f3f6fb 0%, #e8edf6 55%, #dde7f7 100%)',
  imageUrl: '',
  imagePosition: 'cover',
  overlayOpacity: 0,
};

const BASE_LOGO: ThemeTokens['logo'] = {
  url: '',
  alt: 'AgilFrame',
  heightPx: 28,
  position: 'header-left',
};

const BASE_MOTION: ThemeTokens['motion'] = {
  speed: 'normal',
  durationFastMs: 120,
  durationBaseMs: 240,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
};

function buildTheme(
  scheme: Scheme,
  colors: Partial<ColorTokens> = {},
  extra: Partial<Omit<ThemeTokens, 'scheme' | 'colors'>> = {},
): ThemeTokens {
  const base = scheme === 'light' ? LIGHT_COLORS : DARK_COLORS;
  return {
    scheme,
    colors: { ...base, ...colors },
    typography: { ...BASE_TYPOGRAPHY, ...(extra.typography ?? {}) },
    shape: { ...BASE_SHAPE, ...(extra.shape ?? {}) },
    spacing: { ...BASE_SPACING, ...(extra.spacing ?? {}) },
    background: {
      ...BASE_BACKGROUND,
      ...(extra.background ?? {}),
      color: scheme === 'light' ? '#f3f6fb' : '#080d16',
      gradient:
        scheme === 'light'
          ? 'linear-gradient(160deg, #f3f6fb 0%, #e8edf6 55%, #dde7f7 100%)'
          : 'linear-gradient(160deg, #080d16 0%, #0d1422 55%, #101a2e 100%)',
    },
    logo: { ...BASE_LOGO, ...(extra.logo ?? {}) },
    motion: { ...BASE_MOTION, ...(extra.motion ?? {}) },
  };
}

const corporateBrand = generatePalette('#0b5fff', 'light');
const nightBrand = generatePalette('#7c3aed', 'dark');

export const themePresets: Record<ThemePresetName, ThemeTokens> = {
  light: buildTheme('light'),
  dark: buildTheme('dark'),
  corporate: buildTheme('light', {
    primary: corporateBrand.primary,
    primaryHover: corporateBrand.primaryHover,
    primaryActive: corporateBrand.primaryActive,
    onPrimary: corporateBrand.onPrimary,
    accent: corporateBrand.accent,
    onAccent: corporateBrand.onAccent,
    focusRing: corporateBrand.focusRing,
    speakingRing: corporateBrand.speakingRing,
    background: '#f5f8ff',
    backgroundAlt: '#e9effc',
    chatOutgoingBg: '#d7e5ff',
  }, {
    shape: { ...BASE_SHAPE, radiusMd: 10, radiusLg: 16 },
    spacing: { ...BASE_SPACING, density: 'compact' },
  }),
  night: buildTheme('dark', {
    primary: nightBrand.primary,
    primaryHover: nightBrand.primaryHover,
    primaryActive: nightBrand.primaryActive,
    onPrimary: '#ffffff',
    accent: '#22d3ee',
    onAccent: '#04141a',
    focusRing: nightBrand.focusRing,
    speakingRing: nightBrand.speakingRing,
    chatOutgoingBg: '#3b1d8f',
    background: '#0a0714',
    backgroundAlt: '#110b22',
    surface: '#171030',
    surfaceElevated: '#1f1640',
  }),
  minimal: buildTheme('light', {
    primary: '#111827',
    primaryHover: '#1f2937',
    primaryActive: '#374151',
    onPrimary: '#ffffff',
    accent: '#4b5563',
    onAccent: '#ffffff',
    background: '#ffffff',
    backgroundAlt: '#f7f7f8',
    surface: '#ffffff',
    chatOutgoingBg: '#e5e7eb',
    focusRing: '#11182766',
    speakingRing: '#111827',
  }, {
    shape: { ...BASE_SHAPE, radiusSm: 2, radiusMd: 4, radiusLg: 8, shadowSm: 'none', shadowMd: '0 8px 24px rgba(0,0,0,0.12)' },
    motion: { ...BASE_MOTION, speed: 'fast', durationFastMs: 90, durationBaseMs: 160 },
  }),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges a partial patch into a base object. Arrays and primitives are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out as T;
}

/** Resolves a partial theme patch against a preset into a complete, validated theme. */
export function resolveTheme(patch: ThemePatch = {}, scheme: 'light' | 'dark' | 'auto' = 'auto'): ThemeTokens {
  const requested = scheme !== 'auto' ? scheme : ((patch.scheme as 'light' | 'dark' | 'auto' | undefined) ?? 'auto');
  const effective: Scheme = requested === 'auto' ? 'light' : requested;
  const base = structuredClone(themePresets[effective]);
  const merged = deepMerge(base, patch);
  merged.scheme = requested;
  return themeSchema.parse(merged);
}

export function effectiveScheme(theme: ThemeTokens, prefersDark: boolean): Scheme {
  if (theme.scheme === 'light') return 'light';
  if (theme.scheme === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/**
 * Concrete palette for rendering.
 *
 * Explicit themes are returned as-is. A theme with `scheme:'auto'` keeps its
 * custom light palette in light mode and derives a dark variant in dark mode:
 * the brand primary/accent are re-generated for dark surfaces, everything
 * semantic comes from the dark preset (so contrast stays readable).
 */
export function displayTheme(theme: ThemeTokens, prefersDark: boolean): ThemeTokens {
  if (theme.scheme !== 'auto') return theme;
  if (!prefersDark) return theme;
  const palette = generatePalette(theme.colors.primary, 'dark');
  const derived: ThemeTokens = {
    ...structuredClone(theme),
    scheme: 'dark',
    colors: { ...themePresets.dark.colors, ...palette },
    background: {
      ...themePresets.dark.background,
      type: theme.background.type,
      imageUrl: theme.background.imageUrl,
      overlayOpacity: theme.background.overlayOpacity,
    },
  };
  return themeSchema.parse(derived);
}

/** Applies a brand color to an existing theme, keeping contrast sane. */
export function applyBrandColor(
  theme: ThemeTokens,
  brandColor: string,
  options: { surfaces?: boolean } = {},
): ThemeTokens {
  const scheme = theme.scheme === 'auto' ? 'light' : theme.scheme;
  const palette = generatePalette(brandColor, scheme);
  const colors = { ...theme.colors, ...palette, controlDangerBg: theme.colors.controlDangerBg };
  if (options.surfaces) {
    const dark = scheme === 'dark';
    const surface = mix(dark ? '#0b1220' : '#ffffff', brandColor, dark ? 0.12 : 0.05);
    const elevated = mix(dark ? '#121b2c' : '#f8fafc', brandColor, dark ? 0.18 : 0.08);
    const tile = mix(dark ? '#050a12' : '#f1f5f9', brandColor, dark ? 0.08 : 0.03);
    colors.surface = surface;
    colors.surfaceElevated = elevated;
    colors.tileBg = tile;
    colors.tileBorder = mix(dark ? '#1d2a40' : '#d5dde9', brandColor, dark ? 0.28 : 0.18);
    colors.border = mix(dark ? '#293547' : '#d5dde9', brandColor, dark ? 0.3 : 0.22);
    colors.divider = mix(dark ? '#1e293b' : '#e2e8f0', brandColor, dark ? 0.22 : 0.14);
    colors.controlBg = mix(dark ? '#121b2c' : '#ffffff', brandColor, dark ? 0.2 : 0.06);
    colors.controlHover = mix(dark ? '#1a2740' : '#f1f5f9', brandColor, dark ? 0.28 : 0.1);
    colors.controlText = bestTextColor(colors.controlBg, ['#ffffff', '#0f172a']);
    colors.text = bestTextColor(colors.surface, ['#ffffff', '#0f172a']);
    colors.textSecondary = mix(colors.text, colors.surface, 0.2);
    colors.onSurface = colors.text;
  }
  return themeSchema.parse({ ...theme, colors });
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Serializes a full theme into CSS custom properties (consumed by the widget). */
export function toCssVars(theme: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of themeColorKeys) {
    vars[`--agil-color-${kebab(key)}`] = theme.colors[key];
  }
  vars['--agil-scheme'] = effectiveScheme(theme, false);
  vars['--agil-font-family'] = theme.typography.fontFamily;
  vars['--agil-font-family-mono'] = theme.typography.fontFamilyMono;
  vars['--agil-font-size-base'] = `${theme.typography.fontSizeBase}px`;
  vars['--agil-font-weight-regular'] = String(theme.typography.weightRegular);
  vars['--agil-font-weight-medium'] = String(theme.typography.weightMedium);
  vars['--agil-font-weight-bold'] = String(theme.typography.weightBold);
  vars['--agil-heading-weight'] = String(theme.typography.headingWeight);
  vars['--agil-line-height'] = String(theme.typography.lineHeight);
  vars['--agil-letter-spacing'] = `${theme.typography.letterSpacing}em`;
  vars['--agil-radius-sm'] = `${theme.shape.radiusSm}px`;
  vars['--agil-radius-md'] = `${theme.shape.radiusMd}px`;
  vars['--agil-radius-lg'] = `${theme.shape.radiusLg}px`;
  vars['--agil-radius-pill'] = `${theme.shape.radiusPill}px`;
  vars['--agil-shadow-sm'] = theme.shape.shadowSm;
  vars['--agil-shadow-md'] = theme.shape.shadowMd;
  vars['--agil-backdrop-blur'] = `${theme.shape.backdropBlurPx}px`;
  vars['--agil-density'] = theme.spacing.density;
  vars['--agil-gutter'] = `${theme.spacing.gutter}px`;
  vars['--agil-control-size'] = `${theme.spacing.controlSize}px`;
  vars['--agil-control-gap'] = `${theme.spacing.controlGap}px`;
  vars['--agil-bg-type'] = theme.background.type;
  vars['--agil-bg-color'] = theme.background.color;
  vars['--agil-bg-gradient'] = theme.background.gradient;
  vars['--agil-bg-image'] = theme.background.imageUrl ? `url("${theme.background.imageUrl}")` : 'none';
  vars['--agil-bg-overlay'] = String(theme.background.overlayOpacity);
  vars['--agil-logo-height'] = `${theme.logo.heightPx}px`;
  vars['--agil-motion-fast'] = `${theme.motion.speed === 'none' ? 0 : theme.motion.durationFastMs}ms`;
  vars['--agil-motion-base'] = `${theme.motion.speed === 'none' ? 0 : theme.motion.durationBaseMs}ms`;
  vars['--agil-easing'] = theme.motion.easing;
  return vars;
}

export function cssVarsToString(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n');
}

export interface ThemeAuditIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
  tokens: string[];
}

interface ThemeContrastCheck {
  code: string;
  a: keyof ColorTokens;
  b: keyof ColorTokens;
  min: number;
  label: string;
  level?: ThemeAuditIssue['level'];
}

export const themeContrastChecks: readonly ThemeContrastCheck[] = [
  { code: 'text-on-background', a: 'text', b: 'background', min: 4.5, label: 'Основной текст на фоне', level: 'error' },
  { code: 'text-secondary-on-background', a: 'textSecondary', b: 'background', min: 3, label: 'Вторичный текст на фоне' },
  { code: 'on-primary', a: 'onPrimary', b: 'primary', min: 4.5, label: 'Текст на кнопке primary', level: 'error' },
  { code: 'on-accent', a: 'onAccent', b: 'accent', min: 3, label: 'Текст на акценте' },
  { code: 'control-text', a: 'controlText', b: 'controlBg', min: 4.5, label: 'Иконки/текст на контролах' },
  { code: 'chat-outgoing', a: 'chatOutgoingText', b: 'chatOutgoingBg', min: 4.5, label: 'Исходящее сообщение чата' },
  { code: 'chat-incoming', a: 'chatIncomingText', b: 'chatIncomingBg', min: 4.5, label: 'Входящее сообщение чата' },
  { code: 'danger', a: 'onPrimary', b: 'danger', min: 3, label: 'Текст на кнопке danger' },
];

function relativeRatio(a: string, b: string): number {
  try {
    return contrastRatio(a, b);
  } catch {
    return 1;
  }
}

/** Accessibility audit: contrast problems that would make the UI unreadable. */
export function auditTheme(theme: ThemeTokens): ThemeAuditIssue[] {
  const issues: ThemeAuditIssue[] = [];
  for (const { code, a, b, min, label, level = 'warn' } of themeContrastChecks) {
    const fg = theme.colors[a];
    const bg = theme.colors[b];
    const ratio = relativeRatio(fg, bg);
    if (ratio < min) {
      issues.push({
        level,
        code,
        message: `${label}: contrast ${ratio.toFixed(2)}:1 < ${min}:1`,
        tokens: [fg, bg],
      });
    }
  }
  return issues;
}

/** Suggests an accessible text color for any custom surface (helper for editor/MCP). */
export function suggestOnColor(bg: string, candidates?: string[]): string {
  try {
    return bestTextColor(normalizeHex(bg), candidates);
  } catch {
    return '#ffffff';
  }
}

/** Derives a full theme from a brand color in one call (used by editor quick-start + MCP). */
export function themeFromBrandColor(brandColor: string, preset: ThemePresetName = 'light'): ThemeTokens {
  const theme = structuredClone(themePresets[preset]);
  return applyBrandColor(theme, brandColor);
}

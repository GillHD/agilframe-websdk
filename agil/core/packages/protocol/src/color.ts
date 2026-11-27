/**
 * Color utilities used by theming, the visual editor and the MCP server.
 * Browser-safe: no Node.js imports.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type Scheme = 'light' | 'dark';

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Accepts #rgb, #rrggbb, #rrggbbaa, with or without leading '#'. Returns '#rrggbb' (alpha dropped). */
export function normalizeHex(input: string): string {
  const match = HEX_RE.exec(String(input).trim());
  if (!match) throw new Error(`Invalid hex color: ${input}`);
  let hex = (match[1] ?? '').toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return `#${hex.slice(0, 6)}`;
}

export function isHexColor(input: string): boolean {
  try {
    normalizeHex(input);
    return true;
  } catch {
    return false;
  }
}

export function hexToRgb(input: string): RGB {
  const hex = normalizeHex(input).slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function rgbToHex(rgb: RGB): string {
  const to = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(rgb.r)}${to(rgb.g)}${to(rgb.b)}`;
}

function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0..1. */
export function relativeLuminance(input: string): number {
  const { r, g, b } = hexToRgb(input);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG contrast ratio between two colors, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mixes two colors; weight is the amount of `b` (0..1). */
export function mix(a: string, b: string, weight: number): string {
  const w = Math.max(0, Math.min(1, weight));
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

export function lighten(color: string, amount: number): string {
  return mix(color, '#ffffff', amount);
}

export function darken(color: string, amount: number): string {
  return mix(color, '#000000', amount);
}

/** '#rrggbb' + alpha -> '#rrggbbaa'. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return `${normalizeHex(color)}${byte}`;
}

export function isDark(color: string): boolean {
  return relativeLuminance(color) < 0.4;
}

/** Picks the candidate with the best contrast against `background`. */
export function bestTextColor(background: string, candidates: string[] = ['#ffffff', '#000000']): string {
  let best = candidates[0] ?? '#000000';
  let bestRatio = 0;
  for (const candidate of candidates) {
    const ratio = contrastRatio(background, candidate);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

export interface BrandPalette {
  primary: string;
  primaryHover: string;
  primaryActive: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  focusRing: string;
  speakingRing: string;
}

function shiftHue(color: string, degrees: number): string {
  const { r, g, b } = hexToRgb(color);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  h = (h + degrees / 360 + 1) % 1;
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let outR = l;
  let outG = l;
  let outB = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    outR = hue2rgb(p, q, h + 1 / 3);
    outG = hue2rgb(p, q, h);
    outB = hue2rgb(p, q, h - 1 / 3);
  }
  return rgbToHex({ r: outR * 255, g: outG * 255, b: outB * 255 });
}

/**
 * Generates a consistent brand palette from a single brand color.
 * Used by the visual editor ("brand color" field) and by MCP theme generation.
 */
export function generatePalette(brandColor: string, scheme: Scheme = 'light'): BrandPalette {
  const brand = normalizeHex(brandColor);
  const hover = scheme === 'light' ? darken(brand, 0.12) : lighten(brand, 0.14);
  const active = scheme === 'light' ? darken(brand, 0.24) : lighten(brand, 0.26);
  const onPrimary = bestTextColor(brand, ['#ffffff', '#000000', '#0b1220']);
  const accent = shiftHue(brand, scheme === 'light' ? 32 : -32);
  const onAccent = bestTextColor(accent, ['#ffffff', '#000000', '#0b1220']);
  return {
    primary: brand,
    primaryHover: hover,
    primaryActive: active,
    onPrimary,
    accent,
    onAccent,
    focusRing: withAlpha(scheme === 'light' ? darken(brand, 0.2) : lighten(brand, 0.3), 0.6),
    speakingRing: scheme === 'light' ? darken(brand, 0.05) : lighten(brand, 0.1),
  };
}

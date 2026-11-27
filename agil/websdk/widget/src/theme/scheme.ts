/**
 * Palette-correct theme scheme switching.
 *
 * `resolveTheme(patch, scheme)` merges the full theme patch over the *preset* of
 * the requested scheme. When the patch itself is a complete light theme (or a
 * full theme object with `scheme:'dark'`), that merge keeps the light colours and
 * only flips `scheme`, which produces "dark mode with a white background".
 *
 * `themeForScheme()` prevents that: an explicit scheme rebuilds the semantic
 * palette from the corresponding preset, keeping the tenant's brand colours
 * (primary/accent), typography, shape, spacing, logo and background image.
 */
import {
  bestTextColor,
  contrastRatio,
  generatePalette,
  mix,
  relativeLuminance,
  resolveTheme,
  themePresets,
  themeSchema,
  withAlpha,
  type ThemePatch,
  type ThemeScheme,
  type ThemeTokens,
} from '@agil/protocol';

const MIN_TEXT_CONTRAST = 4.5;

/** Mixes the colour toward a readable text colour until WCAG AA is reached. */
function ensureReadable(color: string, background: string, toward: string, min = MIN_TEXT_CONTRAST): string {
  try {
    let candidate = color;
    for (let step = 0; step < 24; step += 1) {
      if (contrastRatio(candidate, background) >= min) return candidate;
      candidate = mix(candidate, toward, 0.12);
    }
    return candidate;
  } catch {
    return color;
  }
}

/** Picks the on-colour and nudges the surface until its text reaches AA. */
function readableSurface(surface: string, toward: string): { surface: string; on: string } {
  let background = surface;
  let on = bestTextColor(background, ['#ffffff', '#000000']);
  for (let step = 0; step < 24; step += 1) {
    if (contrastRatio(on, background) >= MIN_TEXT_CONTRAST) return { surface: background, on };
    background = mix(background, toward, 0.12);
    on = bestTextColor(background, ['#ffffff', '#000000']);
  }
  return { surface: background, on };
}

/**
 * Makes the *final* palette readable: brand colours used as links/icons
 * (primary, accent) are adjusted against the final background, and derived
 * on-colours against their surfaces. This fixes mixed preset×scheme cases like
 * "minimal preset + dark scheme" where the brand primary (#111827) became
 * invisible on the dark background.
 */
export function ensureReadableTheme(theme: ThemeTokens): ThemeTokens {
  try {
    const toward = theme.colors.text;
    const wantsDark = isDarkPalette(theme);
    // Text (links, nav, icons, badges, hints) sits on the background, panels and
    // raised surfaces — the brand colour must be readable on all of them.
    const surfaces = [theme.colors.background, theme.colors.surface, theme.colors.surfaceElevated];
    const ensureOnSurfaces = (color: string): string => {
      let candidate = color;
      for (let step = 0; step < 28; step += 1) {
        if (surfaces.every((surface) => contrastRatio(candidate, surface) >= MIN_TEXT_CONTRAST)) return candidate;
        candidate = mix(candidate, toward, 0.1);
      }
      return candidate;
    };
    const primary = ensureOnSurfaces(theme.colors.primary);
    const primaryHover = ensureOnSurfaces(mix(primary, toward, wantsDark ? 0.18 : 0.12));
    const primaryActive = ensureOnSurfaces(mix(primary, toward, wantsDark ? 0.32 : 0.24));
    const accent = ensureOnSurfaces(theme.colors.accent);
    const textSecondary = ensureOnSurfaces(theme.colors.textSecondary);
    const textMuted = ensureOnSurfaces(theme.colors.textMuted);
    const primaryPair = readableSurface(primary, toward);
    const accentPair = readableSurface(accent, toward);
    const colors = {
      ...theme.colors,
      primary: primaryPair.surface,
      primaryHover,
      primaryActive,
      onPrimary: primaryPair.on,
      accent: accentPair.surface,
      onAccent: accentPair.on,
      textSecondary,
      textMuted,
      focusRing: withAlpha(primaryPair.surface, 0.6),
      speakingRing: primaryPair.surface,
    };
    return themeSchema.parse({ ...theme, colors });
  } catch {
    return theme;
  }
}

/** True when the palette looks like a dark palette (dark bg + light text). */
export function isDarkPalette(theme: ThemeTokens): boolean {
  try {
    const background = relativeLuminance(theme.colors.background);
    const text = relativeLuminance(theme.colors.text);
    return background < 0.4 && text > 0.4;
  } catch {
    return false;
  }
}

/**
 * Returns a theme that actually has a palette for the requested scheme.
 * `auto` uses a light base for `displayTheme()`. Explicit schemes rebuild the
 * palette when it contradicts the requested scheme.
 */
export function themeForScheme(theme: ThemeTokens, scheme: ThemeScheme): ThemeTokens {
  if (scheme === 'auto') {
    const lightBase = isDarkPalette(theme) ? themeForScheme(theme, 'light') : theme;
    return ensureReadableTheme({ ...lightBase, scheme: 'auto' });
  }
  const wantsDark = scheme === 'dark';
  if (theme.scheme === scheme && isDarkPalette(theme) === wantsDark) return ensureReadableTheme(theme);
  if (theme.scheme === 'auto' && isDarkPalette(theme) === wantsDark) {
    return ensureReadableTheme(themeSchema.parse({ ...theme, scheme }));
  }
  const preset = structuredClone(themePresets[scheme]);
  const brand = generatePalette(theme.colors.primary, scheme);
  const next: ThemeTokens = {
    ...preset,
    scheme,
    colors: {
      ...preset.colors,
      ...brand,
      accent: theme.colors.accent || brand.accent,
      onAccent: theme.colors.onAccent || brand.onAccent,
    },
    typography: theme.typography,
    shape: theme.shape,
    spacing: theme.spacing,
    background: {
      ...preset.background,
      type: theme.background.type,
      imageUrl: theme.background.imageUrl,
      overlayOpacity: theme.background.overlayOpacity,
    },
    logo: theme.logo,
    motion: theme.motion,
  };
  return ensureReadableTheme(themeSchema.parse(next));
}

/** Normalises a theme produced by `resolveTheme`/config merges. */
export function normalizeTheme(theme: ThemeTokens): ThemeTokens {
  return themeForScheme(theme, theme.scheme);
}

/** Applies a theme patch and the requested scheme without palette mismatch. */
export function applyThemeScheme(theme: ThemeTokens, patch: ThemePatch, scheme?: ThemeScheme): ThemeTokens {
  const requested = scheme ?? ((patch.scheme as ThemeScheme | undefined) ?? theme.scheme);
  const merged = resolveTheme(patch, requested === 'auto' ? 'auto' : requested);
  const withBrand: ThemeTokens = {
    ...merged,
    colors: {
      ...merged.colors,
      primary: (patch.colors?.primary as string | undefined) ?? theme.colors.primary,
      accent: (patch.colors?.accent as string | undefined) ?? theme.colors.accent,
    },
  };
  return themeForScheme(withBrand, requested);
}

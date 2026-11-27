/**
 * Theme application: converts `ThemeTokens` into CSS custom properties on the
 * widget root and keeps `data-theme` / `data-density` / `data-bg` in sync with
 * the system `prefers-color-scheme` when the theme scheme is `auto`.
 *
 * Every visual style of the widget is expressed through `var(--agil-*)`; this
 * module is the only place that writes those variables.
 */
import {
  deepMerge,
  displayTheme,
  effectiveScheme,
  resolveTheme,
  toCssVars,
  type ThemePatch,
  type ThemeScheme,
  type ThemeTokens,
} from '@agil/protocol';
import { ensureReadableTheme, normalizeTheme, themeForScheme } from './scheme.js';

export interface AppliedTheme {
  /** Theme that is actually rendered (scheme is always concrete here). */
  display: ThemeTokens;
  scheme: 'light' | 'dark';
  vars: Record<string, string>;
}

export class ThemeApplier {
  private readonly root: HTMLElement;
  private readonly media: MediaQueryList | null;
  private readonly onChange: ((applied: AppliedTheme) => void) | undefined;
  private readonly onSystemSchemeChange = (): void => {
    if (this.theme?.scheme !== 'auto') return;
    const applied = this.render();
    this.onChange?.(applied);
  };
  private theme: ThemeTokens | null = null;
  private applied: AppliedTheme | null = null;
  private layoutMode = 'grid';

  constructor(root: HTMLElement, onChange?: (applied: AppliedTheme) => void) {
    this.root = root;
    this.onChange = onChange;
    this.media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    this.media?.addEventListener('change', this.onSystemSchemeChange);
  }

  get current(): AppliedTheme | null {
    return this.applied;
  }

  setTheme(theme: ThemeTokens): AppliedTheme {
    // Guard against "scheme:dark + light palette" themes coming from config
    // merges/URL params: the rendered palette must match data-theme.
    this.theme = normalizeTheme(theme);
    return this.render();
  }

  setLayout(mode: string): void {
    this.layoutMode = mode;
    this.root.dataset.layout = mode;
  }

  getTheme(): ThemeTokens | null {
    return this.theme;
  }

  /** Merges a patch on top of the current theme (used by `updateTheme`). */
  patchTheme(patch: ThemePatch): AppliedTheme {
    const base = this.theme ?? resolveTheme({}, 'auto');
    const merged = deepMerge(structuredClone(base), patch);
    const requested = ((patch.scheme as ThemeScheme | undefined) ?? merged.scheme) as ThemeScheme;
    return this.setTheme(themeForScheme(merged as ThemeTokens, requested));
  }

  private render(): AppliedTheme {
    const theme = this.theme ?? resolveTheme({}, 'auto');
    const prefersDark = this.media?.matches ?? false;
    const scheme = effectiveScheme(theme, prefersDark) as 'light' | 'dark';
    const display = ensureReadableTheme(displayTheme(theme, prefersDark));
    const vars = toCssVars(display);
    for (const [name, value] of Object.entries(vars)) {
      if (value !== undefined) this.root.style.setProperty(name, value);
    }
    this.root.dataset.theme = scheme;
    this.root.dataset.agilScheme = scheme;
    this.root.style.colorScheme = scheme;
    this.root.dataset.density = display.spacing.density;
    this.root.dataset.layout = this.layoutMode;
    this.root.dataset.bg = display.background.type;
    if (display.background.type === 'image' && display.background.imageUrl) {
      this.root.style.setProperty('--agil-bg-image', `url("${display.background.imageUrl}")`);
    }
    this.root.style.backgroundColor = display.background.color;
    this.root.style.color = display.colors.text;
    this.root.style.fontFamily = display.typography.fontFamily;
    const result: AppliedTheme = { display, scheme, vars };
    this.applied = result;
    return result;
  }

  dispose(): void {
    this.media?.removeEventListener('change', this.onSystemSchemeChange);
  }
}

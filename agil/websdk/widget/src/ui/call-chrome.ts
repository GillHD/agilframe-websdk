/**
 * Embedded (embedded call) call chrome policy — pure, DOM-free, unit-tested.
 *
 * The host embeds the widget with `layout.chrome:'none'` inside a card that is
 * ~648–680 px wide even on a 1440 px page. Chrome-less mode used to hide the
 * widget header entirely and leave one 52 px pager band above a floating island:
 * the Сетка/Спикер switch got its own full-width row and the call still looked
 * like a phone UI on a desktop. This policy promotes the embedded call to a
 * compact desktop chrome:
 *
 *  - a real (compact) header with room/status/count and the view switch;
 *  - no separate pager row;
 *  - one horizontal rectangular dock for the call actions.
 *
 * It is only enabled when *all* of these hold:
 *  - the widget is embedded (`embedded:true`);
 *  - the host asked for chrome-less embedding (`chrome:'none'`);
 *  - the primary pointer is fine (mouse/trackpad — phones and tablets keep the
 *    touch-friendly 44 px island);
 *  - there is desktop room: viewport ≥760 px **or** the host card itself is at
 *    least 600 px wide (the embedded call card is ~648 px inside a 1440 page, so a
 *    viewport-only check would wrongly keep the mobile layout there).
 *
 * The default full-chrome widget and all touch layouts are untouched.
 */
import type { LayoutChrome } from '../types.js';

/** Nominal desktop threshold (documented contract). */
export const EMBEDDED_DESKTOP_MIN_VIEWPORT = 760;
/** The embedded host card is narrower than the viewport; 600 px is the floor. */
export const EMBEDDED_DESKTOP_MIN_HOST = 600;

export type CallChromeMode = 'default' | 'embedded-desktop';

export interface EmbeddedChromeInput {
  embedded: boolean;
  chrome: LayoutChrome;
  /** `matchMedia('(pointer: fine)').matches` — no touch-first device. */
  pointerFine: boolean;
  viewportWidth: number;
  /** Measured width of the widget host; 0/NaN before the first layout. */
  hostWidth: number;
}

/**
 * Resolve whether the embedded call should use the desktop chrome.
 *
 * A wide viewport with a narrow host still qualifies when the host itself is
 * wide enough: the embedded call page puts the call in a half-width card, so
 * `window.innerWidth` alone would be the wrong signal.
 */
export function resolveCallChrome(input: EmbeddedChromeInput): CallChromeMode {
  if (!input.embedded || input.chrome !== 'none' || !input.pointerFine) return 'default';
  const viewport = Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0;
  const host = Number.isFinite(input.hostWidth) ? input.hostWidth : 0;
  if (viewport >= EMBEDDED_DESKTOP_MIN_VIEWPORT) return 'embedded-desktop';
  if (host >= EMBEDDED_DESKTOP_MIN_HOST) return 'embedded-desktop';
  return 'default';
}

/** True when the embedded desktop chrome (header switch + rectangular dock) wins. */
export function isEmbeddedDesktopChrome(input: EmbeddedChromeInput): boolean {
  return resolveCallChrome(input) === 'embedded-desktop';
}

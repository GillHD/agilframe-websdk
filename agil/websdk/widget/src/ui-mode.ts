/**
 * UI mode resolution (contract: `ui: 'default' | 'headless'`).
 *
 * `ui` is the explicit switch; `headless: true` is a backwards-friendly alias.
 * The function is DOM-free so it can be unit-tested and reused by host tooling.
 */
import type { AgilCallOptions, AgilUiMode } from './types.js';

export type UiMode = AgilUiMode;

export function resolveUiMode(options: Pick<AgilCallOptions, 'ui' | 'headless'> | null | undefined): UiMode {
  if (!options) return 'default';
  if (options.ui === 'headless' || options.ui === 'default') return options.ui;
  return options.headless === true ? 'headless' : 'default';
}

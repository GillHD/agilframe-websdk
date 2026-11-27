/**
 * Toolbar density policy for the call screen (pure, DOM-free, unit-tested).
 *
 * The call UI is compared with Jitsi/Zoom in `docs/call-ui-v3.md`. The short
 * version: the toolbar only carries the actions a call actually needs at its
 * current size; everything else lives behind one “⋯” overflow. The header
 * owns the participant list. Notes and transcript use the call toolbar.
 *
 * Buckets are total participants (self included):
 *   solo  1–2   mic, camera, screen, chat, leave
 *   duo   3–4   + raise hand, reactions
 *   group 5–8   + captions (when the feature is on)
 *   large 9+    + recording (when the feature is on)
 *
 * The bar groups devices, meeting actions, and leave in a compact row.
 */
import type { ControlId } from '@agil/protocol';

/**
 * `dock` is the embedded-desktop toolbar (docs/call-ui-v3.md §9): one compact
 * rectangular row over the bottom of the stage, with left/centre/right zones.
 * It is selected by `resolveControlsStyle()` and never configured by tenants.
 */
export type ControlsStyle = 'bar' | 'island' | 'minimal' | 'dock';

export type ControlButtonId =
  | ControlId
  | 'captions'
  | 'pip'
  | 'mic-settings'
  | 'video-menu'
  | 'invite'
  | 'polls'
  | 'whiteboard'
  | 'annotate'
  | 'breakout';

export type ControlDensity = 'solo' | 'duo' | 'group' | 'large';

/** Below/equal this viewport width the classic bar collapses into the island. */
export const CONTROLS_NARROW_MAX_WIDTH = 640;
export const CONTROLS_WIDE_INVITE_MIN_WIDTH = 720;

/** Total participants (self included) that open each density bucket. */
export const CONTROL_DENSITY_THRESHOLDS: Readonly<Record<Exclude<ControlDensity, 'solo'>, number>> = {
  duo: 3,
  group: 5,
  large: 9,
};

/** Panel entries live in the header; repeating them in the toolbar is clutter. */
export const HEADER_OWNED_CONTROLS: readonly ControlButtonId[] = ['participants'];

export const ISLAND_KEYS: readonly ControlButtonId[] = ['mic', 'camera', 'screen', 'chat', 'assistant'];
export const MINIMAL_KEYS: readonly ControlButtonId[] = ['mic', 'camera'];

const QUICK_ACCESS_ACTIONS: readonly ControlButtonId[] = [
  'screen', 'chat', 'hand', 'reactions', 'polls', 'whiteboard', 'annotate',
  'breakout', 'assistant', 'captions', 'fullscreen', 'settings', 'invite',
];

/** Fill gaps left by unavailable primary actions without growing the toolbar. */
export function fillQuickAccess(
  primary: readonly ControlButtonId[],
  overflow: readonly ControlButtonId[],
  visible: (id: ControlButtonId) => boolean,
): ControlButtonId[] {
  const remaining = primary.filter(visible);
  const replacements = [...new Set(overflow)].filter((id) =>
    QUICK_ACCESS_ACTIONS.includes(id) && !primary.includes(id) && visible(id));
  return [...remaining, ...replacements.slice(0, primary.length - remaining.length)];
}

/** Available width of the call surface, including the split device buttons. */
export function compactControlKeys(width: number, touch = false): readonly ControlButtonId[] {
  // Four touch targets at 44px, three 4px gaps, 10px of padding/border,
  // and 16px of outside margins. Each additional action adds 48px.
  if (width >= (touch ? 358 : 390) || width <= 0) return ISLAND_KEYS;
  if (width >= (touch ? 310 : 330)) return ['mic', 'camera', 'chat', 'assistant'];
  if (width >= (touch ? 262 : 280)) return ['mic', 'camera', 'assistant'];
  return MINIMAL_KEYS;
}

export function callControlsWidth(surface: HTMLElement): number {
  const viewport = surface.ownerDocument.defaultView?.innerWidth ?? 0;
  return Math.min(surface.clientWidth || viewport, viewport || surface.clientWidth);
}

export function usesCompactTouchControls(surface: HTMLElement, width = callControlsWidth(surface)): boolean {
  return isNarrowControlsViewport(width)
    && surface.closest<HTMLElement>('.agil-root')?.dataset.agilDocumentPip !== 'true'
    && (surface.ownerDocument.defaultView?.matchMedia('(pointer: coarse)').matches ?? false);
}

/** Left zone: media + camera menu, fixed for every bucket. */
export const BAR_LEFT: readonly ControlButtonId[] = ['mic', 'camera'];
/** Centre zone: the only part that grows with call size. */
export const BAR_CENTER: Readonly<Record<ControlDensity, readonly ControlButtonId[]>> = {
  solo: ['screen', 'chat', 'fullscreen', 'hand', 'reactions'],
  duo: ['screen', 'chat', 'fullscreen', 'hand', 'reactions'],
  group: ['screen', 'chat', 'fullscreen', 'hand', 'reactions', 'captions'],
  large: ['screen', 'chat', 'fullscreen', 'hand', 'reactions', 'captions', 'recording'],
};
/** Right zone: overflow then the destructive action, always in the same place. */
export const BAR_RIGHT: readonly ControlButtonId[] = ['assistant', 'leave'];

export function controlDensity(total: number): ControlDensity {
  const safe = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1;
  if (safe < CONTROL_DENSITY_THRESHOLDS.duo) return 'solo';
  if (safe < CONTROL_DENSITY_THRESHOLDS.group) return 'duo';
  if (safe < CONTROL_DENSITY_THRESHOLDS.large) return 'group';
  return 'large';
}

/** `controlsStyle: 'bar'` is unusable below 640 px (it would wrap into rows). */
export function isNarrowControlsViewport(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth <= CONTROLS_NARROW_MAX_WIDTH;
}

export function resolveControlsStyle(
  configured: ControlsStyle | undefined,
  narrow: boolean,
  embeddedDesktop = false,
): ControlsStyle {
  // The embedded desktop chrome always owns the toolbar: a tenant-configured
  // island becomes the rectangular dock, and the phone collapse does not apply
  // because this mode is only reachable with a fine pointer and ≥600 px host.
  if (embeddedDesktop) return 'dock';
  const style: ControlsStyle = configured ?? 'bar';
  return style === 'bar' && narrow ? 'island' : style;
}

/** Primary buttons of the classic bar in canonical order, for tests/metrics. */
export function primaryBarControls(density: ControlDensity): ControlButtonId[] {
  return [...BAR_LEFT, ...BAR_CENTER[density], ...BAR_RIGHT];
}

/** True when the control may be rendered outside the overflow popover. */
export function isPrimaryBarControl(id: ControlButtonId, density: ControlDensity): boolean {
  return BAR_CENTER[density].includes(id) || BAR_LEFT.includes(id) || BAR_RIGHT.includes(id);
}

/**
 * Overflow contents: everything visible that is not primary, not a header
 * panel entry and not the camera chevron (which travels with the camera).
 */
export function overflowBarControls(
  order: readonly ControlButtonId[],
  density: ControlDensity,
  isVisible: (id: ControlButtonId) => boolean,
): ControlButtonId[] {
  const seen = new Set<ControlButtonId>();
  return order.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === 'video-menu' || id === 'leave') return false;
    if (HEADER_OWNED_CONTROLS.includes(id)) return false;
    if (isPrimaryBarControl(id, density)) return false;
    return isVisible(id);
  });
}

/** Overflow buckets shown as headings in the “⋯” popover (C-08). */
export type OverflowGroup = 'media' | 'meeting' | 'admin';

/** Group label i18n keys, in render order. */
export const OVERFLOW_GROUP_LABEL_KEYS: Readonly<Record<OverflowGroup, 'moreGroupMedia' | 'moreGroupMeeting' | 'moreGroupAdmin'>> = {
  media: 'moreGroupMedia',
  meeting: 'moreGroupMeeting',
  admin: 'moreGroupAdmin',
};

const OVERFLOW_GROUP_ORDER: readonly OverflowGroup[] = ['media', 'meeting', 'admin'];

/**
 * Which group an overflow action belongs to. Keeping the split explicit means
 * the popover can show “Медиа / Встреча / Администрирование” headings and the
 * caller never invents its own ordering.
 */
export function overflowGroupOf(id: ControlButtonId): OverflowGroup {
  switch (id) {
    case 'mic-settings':
    case 'video-menu':
    case 'pip':
    case 'fullscreen':
    case 'newtab':
    case 'minimize':
      return 'media';
    case 'settings':
      return 'admin';
    default:
      return 'meeting';
  }
}

export interface OverflowGroupEntry {
  readonly group: OverflowGroup;
  readonly ids: readonly ControlButtonId[];
}

/**
 * Split the overflow list into non-empty groups, preserving the configured
 * order inside each group. Empty groups are dropped so the popover has no
 * dangling headings.
 */
export function groupOverflowControls(ids: readonly ControlButtonId[]): OverflowGroupEntry[] {
  const buckets = new Map<OverflowGroup, ControlButtonId[]>();
  for (const id of ids) {
    const group = overflowGroupOf(id);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(id);
    else buckets.set(group, [id]);
  }
  return OVERFLOW_GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => ({
    group,
    ids: buckets.get(group) ?? [],
  }));
}

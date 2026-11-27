/**
 * Inline SVG icon set. The widget ships without an icon font/library: paths are
 * embedded, colors come from `currentColor` so every icon follows theme tokens.
 */

export type IconName =
  | 'mic'
  | 'mic-off'
  | 'camera'
  | 'camera-off'
  | 'screen'
  | 'screen-off'
  | 'blur'
  | 'chat'
  | 'hand'
  | 'smile'
  | 'settings'
  | 'leave'
  | 'send'
  | 'close'
  | 'paperclip'
  | 'download'
  | 'play'
  | 'pin'
  | 'fullscreen'
  | 'pip'
  | 'shield'
  | 'check'
  | 'note'
  | 'poll'
  | 'sparkles'
  | 'transcript'
  | 'record'
  | 'users'
  | 'warning'
  | 'quality'
  | 'info'
  | 'copy'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'refresh'
  | 'grid'
  | 'minimize'
  | 'restore'
  | 'external'
  | 'more'
  | 'user-check'
  | 'whiteboard'
  | 'pen'
  | 'eraser'
  | 'undo'
  | 'trash'
  | 'speaker'
  | 'volume'
  | 'target'
  | 'rooms';

interface IconPath {
  d: string;
  fill?: boolean;
}

const PATHS: Record<IconName, IconPath[]> = {
  volume: [{ d: 'M3 9h4l5-4v14l-5-4H3zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12' }],
  quality: [{ d: 'M4 17a8 8 0 1 1 16 0M12 15l4-5M7 15h.01M12 9h.01M17 15h.01' }],
  mic: [
    { d: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z' },
    { d: 'M19 11a7 7 0 0 1-14 0M12 18v3M8 21h8' },
  ],
  'mic-off': [
    { d: 'M9 9v2a3 3 0 0 0 4.6 2.5M15 10.5V5a3 3 0 0 0-5.6-1.5' },
    { d: 'M19 11a7 7 0 0 1-10.8 6M5 11a7 7 0 0 0 .8 3.2M12 18v3M8 21h8M3 3l18 18' },
  ],
  camera: [
    { d: 'M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 3.5V7l-4 3.5z' },
  ],
  'camera-off': [
    { d: 'M17 10.5V7a2 2 0 0 0-2-2H9M5 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 3.5V7l-4 3.5' },
    { d: 'M3 3l18 18' },
  ],
  screen: [{ d: 'M3 5h18v11H3zM8 21h8M12 16v5' }],
  'screen-off': [{ d: 'M3 5h18v11H3zM8 21h8M12 16v5M3 3l18 18' }],
  blur: [
    { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
    { d: 'M8 12h.01M12 8h.01M16 12h.01M12 16h.01M9.5 9.5h.01M14.5 14.5h.01' },
  ],
  chat: [{ d: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z' }],
  hand: [
    { d: 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7M17 13V9a1.5 1.5 0 0 1 3 0v4a8 8 0 0 1-8 8h-1a7 7 0 0 1-6-3.5L3 14a1.6 1.6 0 0 1 2.7-1.7L8 15' },
  ],
  smile: [
    { d: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
    { d: 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01' },
  ],
  settings: [
    { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
    { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' },
  ],
  leave: [
    { d: 'M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11 11 0 0 0 3.5.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11 11 0 0 0 .6 3.5 1 1 0 0 1-.2 1l-2.3 2.3z' },
  ],
  send: [{ d: 'M2 21l21-9L2 3v7l15 2-15 2v7z', fill: true }],
  close: [{ d: 'M6 6l12 12M18 6L6 18' }],
  paperclip: [{ d: 'M21.4 11.6l-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  download: [{ d: 'M12 3v12M6 11l6 6 6-6M4 21h16' }],
  play: [{ d: 'M8 5v14l11-7z', fill: true }],
  pin: [{ d: 'M9 3h6l-1 6 4 4v2h-5v6h-2v-6H6v-2l4-4-1-6z' }],
  fullscreen: [{ d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
  pip: [{ d: 'M3 5h18v14H3zM13 13h6v5h-6z' }],
  shield: [{ d: 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z' }],
  check: [{ d: 'M20 6L9 17l-5-5' }],
  note: [{ d: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4' }],
  poll: [{ d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }],
  sparkles: [
    { d: 'M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z' },
    { d: 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z' },
  ],
  transcript: [{ d: 'M4 5h16M4 10h16M4 15h10M4 20h6' }],
  record: [
    { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
    { d: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', fill: true },
  ],
  users: [
    { d: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1' },
    { d: 'M17 4a4 4 0 0 1 0 8M22 21v-1a5 5 0 0 0-4-4.9' },
  ],
  warning: [{ d: 'M12 3l10 18H2L12 3zM12 9v5M12 17h.01' }],
  info: [{ d: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7h.01' }],
  copy: [{ d: 'M9 9h11v11H9zM5 15V5h10' }],
  'chevron-left': [{ d: 'M15 5l-7 7 7 7' }],
  'chevron-right': [{ d: 'M9 5l7 7-7 7' }],
  'chevron-up': [{ d: 'M5 15l7-7 7 7' }],
  sun: [
    { d: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z' },
    { d: 'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' },
  ],
  moon: [{ d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }],
  monitor: [{ d: 'M3 4h18v12H3zM8 20h8M12 16v4' }],
  refresh: [{ d: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5' }],
  grid: [{ d: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' }],
  minimize: [{ d: 'M4 4h16v12H4zM8 20h8M12 16v4M13 13l5-5M18 8v3h-3' }],
  restore: [{ d: 'M4 4h16v12H4zM8 20h8M12 16v4M18 8l-5 5M13 13v-3h3' }],
  external: [{ d: 'M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }],
  more: [{ d: 'M5 12h.01M12 12h.01M19 12h.01' }],
  'user-check': [{ d: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 11l2 2 4-4' }],
  whiteboard: [
    { d: 'M3 4h18v13H3zM8 17v4M16 17v4M6 21h12' },
    { d: 'M7 12l3-3 2 2 4-4' },
  ],
  pen: [{ d: 'M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16l-1 4zM14 6l4 4' }],
  eraser: [{ d: 'M7 21h13M5 15l6-6 7 7-3 3H8l-3-4zM11 9l4-4 6 6-4 4' }],
  undo: [{ d: 'M9 7H4v-5M4 7a9 9 0 1 1 0 12' }],
  trash: [{ d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6' }],
  // Distinct metaphors so layout/view actions stop sharing one glyph (C-10):
  // speaker view = one large tile, follow = a target, breakout = doorways.
  speaker: [{ d: 'M3 4h12v16H3zM18 5h3v3h-3zM18 10h3v3h-3zM18 15h3v3h-3z' }],
  target: [
    { d: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z' },
    { d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
    { d: 'M12 2v3M12 19v3M2 12h3M19 12h3' },
  ],
  rooms: [{ d: 'M3 21h18M6 21V4h6v17M15 21V9h4v12M8 9h2M8 14h2' }],
};

/** Runtime list used to validate `iconUrls` keys without exporting the path map. */
export const iconNames: readonly IconName[] = Object.freeze(Object.keys(PATHS) as IconName[]);

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(PATHS, value);
}

export function icon(name: IconName, size = 20): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  // Stable hook used by `iconUrls` overrides (custom-icons.ts) and host CSS.
  el.setAttribute('data-agil-icon', name);
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  const paths = PATHS[name] ?? [];
  for (const path of paths) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('d', path.d);
    if (path.fill) {
      node.setAttribute('fill', 'currentColor');
      node.setAttribute('stroke', 'none');
    }
    el.appendChild(node);
  }
  return el;
}

/** Creates a `<button>` with an icon and an aria-label/title. */
export function iconButton(
  name: IconName,
  label: string,
  options: { onClick?: () => void; className?: string; dataset?: Record<string, string>; size?: number; pressed?: boolean } = {},
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = options.className ?? 'agil-icon-btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed));
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) button.dataset[key] = value;
  }
  button.appendChild(icon(name, options.size ?? 20));
  if (options.onClick) button.addEventListener('click', options.onClick);
  return button;
}

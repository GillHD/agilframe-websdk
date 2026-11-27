/**
 * Vector reaction emoji.
 *
 * Native emoji fonts rasterise differently between platforms and look pixelated
 * when scaled (the customer complaint). Reactions are rendered as inline SVG
 * with integer pixel sizes and no CSS transforms, so they are sharp at 16–32px
 * on both DPR 1 and 2 and in light/dark themes.
 */
import type { I18nKey } from '../i18n.js';

export type ReactionId = 'thumbs-up' | 'clap' | 'party' | 'heart' | 'laugh' | 'raise-hand';

export interface ReactionDefinition {
  id: ReactionId;
  char: string;
  /** i18n key for the accessible label. */
  labelKey: I18nKey;
}

export const REACTION_LIST: ReactionDefinition[] = [
  { id: 'thumbs-up', char: '👍', labelKey: 'reactionThumbsUp' },
  { id: 'clap', char: '👏', labelKey: 'reactionClap' },
  { id: 'party', char: '🎉', labelKey: 'reactionParty' },
  { id: 'heart', char: '❤️', labelKey: 'reactionHeart' },
  { id: 'laugh', char: '😂', labelKey: 'reactionLaugh' },
  { id: 'raise-hand', char: '🙋', labelKey: 'reactionRaiseHand' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function path(d: string, fill: string, extra: Record<string, string> = {}): SVGElement {
  return svgEl('path', { d, fill, ...extra });
}

function circle(cx: string, cy: string, r: string, fill: string): SVGElement {
  return svgEl('circle', { cx, cy, r, fill });
}

/** Builds a vector reaction for one of the built-in reactions. */
export function reactionSvg(id: ReactionId, size = 22): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: String(Math.round(size)),
    height: String(Math.round(size)),
    class: 'agil-emoji-svg',
    role: 'img',
    'aria-hidden': 'true',
    focusable: 'false',
  }) as SVGSVGElement;
  switch (id) {
    case 'thumbs-up':
      svg.appendChild(path('M9 21H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h4v9z', '#d99a26'));
      svg.appendChild(path('M9 20.5V11l4.2-7.6a1.4 1.4 0 0 1 2.6.7V9h4a2 2 0 0 1 2 2.3l-1.3 7A2.5 2.5 0 0 1 18 20.5H9z', '#f5c542'));
      svg.appendChild(path('M9 11h4.2l1.2-2.2H10L9 11z', '#ffffff', { opacity: '0.35' }));
      break;
    case 'clap':
      svg.appendChild(circle('6.2', '5.4', '1.1', '#f2c94c'));
      svg.appendChild(circle('18.2', '5.4', '1.1', '#f2c94c'));
      svg.appendChild(circle('12', '3.4', '1', '#f2994a'));
      svg.appendChild(path('M8.6 9.2l3.2 8.2-2.9 2.3-4-7.4 3.7-3.1z', '#f5c542'));
      svg.appendChild(path('M15 9.2l-3.2 8.2 2.9 2.3 4-7.4L15 9.2z', '#e8b23a'));
      break;
    case 'party':
      svg.appendChild(path('M4 20L13 8l3 3L7 21a1 1 0 0 1-1.4 0L4 20z', '#f2994a'));
      svg.appendChild(path('M4 20L7 21l2-6-3-3-2 8z', '#e76f51'));
      svg.appendChild(circle('16.5', '5', '1.3', '#8576ff'));
      svg.appendChild(circle('20', '9', '1.1', '#2ecc71'));
      svg.appendChild(circle('13', '3.4', '1', '#f2c94c'));
      svg.appendChild(path('M16 12l4-1 .4 1.6-4 1z', '#2ecc71'));
      break;
    case 'heart':
      svg.appendChild(path('M12 21s-7.2-4.6-9.2-9.1A5.1 5.1 0 0 1 12 7.2a5.1 5.1 0 0 1 9.2 4.7C19.2 16.4 12 21 12 21z', '#e63946'));
      svg.appendChild(path('M8 8.4a2.4 2.4 0 0 1 2.1-1.2', '#ffffff', { opacity: '0.45', 'stroke-width': '1.2', stroke: '#ffffff', fill: 'none' }));
      break;
    case 'laugh':
      svg.appendChild(circle('12', '12', '9.2', '#f5c542'));
      svg.appendChild(path('M7.4 9.4c.8-1.3 2.4-1.3 3.2 0', '#5b3a00', { stroke: '#5b3a00', 'stroke-width': '1.6', 'stroke-linecap': 'round', fill: 'none' }));
      svg.appendChild(path('M13.4 9.4c.8-1.3 2.4-1.3 3.2 0', '#5b3a00', { stroke: '#5b3a00', 'stroke-width': '1.6', 'stroke-linecap': 'round', fill: 'none' }));
      svg.appendChild(path('M7.4 13.2h9.2c-.4 3-2.2 4.8-4.6 4.8s-4.2-1.8-4.6-4.8z', '#7a3e00'));
      svg.appendChild(path('M9.2 15.6c1.6 1.2 4 1.2 5.6 0', '#ffffff', { opacity: '0.5', stroke: '#ffffff', 'stroke-width': '1', fill: 'none' }));
      break;
    case 'raise-hand':
    default:
      svg.appendChild(path('M7.2 13.2V6.4a1.5 1.5 0 0 1 3 0v5.4h.4V4.6a1.5 1.5 0 0 1 3 0v7.2h.4V6.2a1.5 1.5 0 0 1 3 0v6h.4V8.4a1.5 1.5 0 0 1 3 0v6.4c0 3.4-2.7 6.2-6.1 6.2h-.9c-2.4 0-4.6-1.4-5.6-3.6L4.6 14a1.6 1.6 0 0 1 2.6-1.8l.8 1z', '#f5c542'));
      break;
  }
  return svg;
}

/** Matches a unicode reaction character to its vector id (chat/toolbar). */
export function reactionIdForChar(char: string): ReactionId | null {
  const found = REACTION_LIST.find((item) => item.char === char || item.char.replace(/\ufe0f/g, '') === char.replace(/\ufe0f/g, ''));
  return found?.id ?? null;
}

/** Renders a reaction character as vector SVG when known, otherwise as text. */
export function reactionNode(char: string, size = 22): Node {
  const id = reactionIdForChar(char);
  if (id) return reactionSvg(id, size);
  const span = document.createElement('span');
  span.className = 'agil-emoji-text';
  span.textContent = char;
  return span;
}

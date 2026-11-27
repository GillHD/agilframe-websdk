/**
 * Lazy collaboration surfaces: the whiteboard card and the screen-share
 * annotation layer (optional `features.whiteboard` / `features.annotations`).
 *
 * `index.ts` pulls this module through a dynamic `import()`: the stroke model,
 * canvas renderer, toolbar and overlay markup are only downloaded when a room
 * actually starts a board or an annotation session. Most calls never touch
 * either surface, so paying for them in the initial widget entry is wasteful.
 *
 * Everything else (permissions, signaling, state mirroring) stays in the
 * controller; this module only builds the two DOM surfaces from the same
 * actions the controller used to pass to them directly.
 */
import type { ClientMessage } from '@agil/protocol';
import type { I18n } from '../i18n.js';
import { AnnotationOverlay } from './annotation-overlay.js';
import { WhiteboardPanel } from './whiteboard-panel.js';

/** Actions shared by both surfaces (superset of their individual contracts). */
export interface CollaborationActions {
  send: (message: ClientMessage) => void;
  canManage: () => boolean;
  self: () => { id: string; name: string };
  onVisibilityChange: () => void;
  onDenied: (text: string) => void;
  isPresenter: () => boolean;
  onExit: () => void;
  onNotice: (text: string) => void;
}

export interface CollaborationSurface {
  whiteboard: WhiteboardPanel;
  annotation: AnnotationOverlay;
  destroy: () => void;
}

/** Builds both surfaces and appends their elements to the widget root. */
export function createCollaborationSurface(
  root: HTMLElement,
  i18n: I18n,
  actions: CollaborationActions,
): CollaborationSurface {
  const whiteboard = new WhiteboardPanel(root, i18n, {
    send: actions.send,
    canManage: actions.canManage,
    self: actions.self,
    onVisibilityChange: actions.onVisibilityChange,
    onDenied: actions.onDenied,
  });
  const annotation = new AnnotationOverlay(root, i18n, {
    send: actions.send,
    canManage: actions.canManage,
    isPresenter: actions.isPresenter,
    self: actions.self,
    onExit: actions.onExit,
    onNotice: actions.onNotice,
  });
  return {
    whiteboard,
    annotation,
    destroy: () => {
      whiteboard.destroy();
      annotation.destroy();
    },
  };
}

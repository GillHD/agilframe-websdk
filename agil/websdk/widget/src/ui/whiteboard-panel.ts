/**
 * In-call whiteboard panel (optional `features.whiteboard`).
 *
 * A floating card with a normalized-coordinate canvas: strokes sync through the
 * signaling server (`whiteboard.*`), replay on join and survive a reconnect.
 * The model is shared with the headless tests (`call/whiteboard.ts`).
 *
 * Permission model (also enforced server-side): everyone may draw, `undo`
 * removes only the caller's last stroke, and `clear`/`close` require
 * host/moderator. Closing the panel is local; «Завершить доску» ends the board
 * for the whole room.
 */
import type { ClientMessage, WhiteboardAuthor, WhiteboardSnapshot, WhiteboardStroke, WhiteboardSyncReason } from '@agil/protocol';
import { WHITEBOARD_DEFAULT_COLOR, WHITEBOARD_DEFAULT_WIDTH } from '@agil/protocol';
import { createStrokeLayer, type LocalStroke, type StrokeLayer } from '../call/whiteboard.js';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { StrokeCanvas } from './whiteboard-canvas.js';
import { StrokeToolbar } from './stroke-toolbar.js';

export interface WhiteboardPanelActions {
  send: (message: ClientMessage) => void;
  canManage: () => boolean;
  self: () => { id: string; name: string };
  /** Notifies the controller so `CallState.whiteboard.visible` stays accurate. */
  onVisibilityChange?: (visible: boolean) => void;
  /** Any board/model change (used to mirror counts into the store). */
  onChange?: () => void;
  onDenied?: (text: string) => void;
}

export class WhiteboardPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: WhiteboardPanelActions;
  private readonly layer: StrokeLayer = createStrokeLayer('whiteboard');
  private readonly toolbar: StrokeToolbar;
  private readonly renderer: StrokeCanvas;
  private readonly canvasWrap: HTMLDivElement;
  private readonly emptyHint: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly lockedBadge: HTMLSpanElement;
  private readonly endButton: HTMLButtonElement;
  private readonly card: HTMLElement;
  private readonly onResize = (): void => this.handleResize();
  private visible = false;
  private draft: LocalStroke | null = null;
  private pointerId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(root: HTMLElement, i18n: I18n, actions: WhiteboardPanelActions) {
    this.i18n = i18n;
    this.actions = actions;

    this.status = h('div', { class: 'agil-whiteboard-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.status.hidden = true;
    this.lockedBadge = h('span', { class: 'agil-whiteboard-locked', text: i18n.t('whiteboardLocked') });
    this.lockedBadge.hidden = true;

    const close = h('button', {
      class: 'agil-icon-btn agil-whiteboard-close',
      title: i18n.t('close'),
      attrs: { 'aria-label': i18n.t('close') },
    });
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', () => this.close());

    const canvas = h('canvas', {
      class: 'agil-whiteboard-canvas',
      dataset: { agilWhiteboardCanvas: '' },
      attrs: { role: 'img', 'aria-label': i18n.t('whiteboardTitle'), tabindex: '0' },
    });
    this.canvasWrap = h('div', { class: 'agil-whiteboard-canvas-wrap' }, canvas);
    this.emptyHint = h('div', { class: 'agil-whiteboard-empty', text: i18n.t('whiteboardHint') });
    this.canvasWrap.appendChild(this.emptyHint);
    this.renderer = new StrokeCanvas(canvas);

    this.toolbar = new StrokeToolbar(i18n, {
      variant: 'board',
      canClear: () => this.actions.canManage(),
      onTool: (tool) => {
        canvas.dataset.tool = tool;
        this.setStatus('', false);
      },
      onColor: () => this.setStatus('', false),
      onWidth: () => this.setStatus('', false),
      onUndo: () => {
        this.actions.send(this.layer.command('undo'));
        this.setStatus('', false);
      },
      onClear: () => {
        if (!this.actions.canManage()) {
          this.setStatus(this.i18n.t('whiteboardGuestClear'), true);
          return;
        }
        this.actions.send(this.layer.command('clear'));
      },
    });
    canvas.dataset.tool = 'pen';
    // Restore the last color/width chosen in this session.
    this.toolbar.sync({ color: WHITEBOARD_DEFAULT_COLOR, width: WHITEBOARD_DEFAULT_WIDTH });

    this.endButton = h('button', { class: 'agil-btn agil-btn-ghost agil-whiteboard-end', text: i18n.t('whiteboardEnd') });
    this.endButton.type = 'button';
    this.endButton.hidden = true;
    this.endButton.addEventListener('click', () => {
      this.actions.send({ type: 'whiteboard.close' });
    });

    this.card = h(
      'section',
      {
        class: 'agil-whiteboard-card',
        attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': i18n.t('whiteboardTitle') },
      },
      h(
        'header',
        { class: 'agil-whiteboard-head' },
        h('h2', { class: 'agil-panel-title', text: i18n.t('whiteboardTitle') }),
        this.lockedBadge,
        close,
      ),
      this.toolbar.element,
      this.canvasWrap,
      h('footer', { class: 'agil-whiteboard-foot' }, this.status, this.endButton),
    );
    this.element = h('div', { class: 'agil-whiteboard-overlay', dataset: { agilWhiteboard: '' } }, this.card);
    this.element.hidden = true;
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });
    root.appendChild(this.element);
    this.bindCanvas(canvas);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvasWrap);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
    this.render();
  }

  /* ------------------------------- lifecycle ------------------------------- */

  isOpen(): boolean {
    return this.visible;
  }

  /** Observable board state for `CallState.whiteboard`. */
  boardState(): { open: boolean; locked: boolean; strokes: number; visible: boolean } {
    return { open: this.layer.open, locked: this.layer.locked, strokes: this.layer.length, visible: this.visible };
  }

  open(): void {
    if (!this.visible) {
      this.visible = true;
      this.element.hidden = false;
      this.actions.onVisibilityChange?.(true);
    }
    this.handleResize();
    this.toolbar.sync({ canClear: this.actions.canManage(), disabled: false });
    this.endButton.hidden = !this.actions.canManage();
    if (this.layer.locked && !this.actions.canManage()) {
      this.lockedBadge.hidden = false;
      this.setStatus(this.i18n.t('whiteboardLocked'), true);
      return;
    }
    this.lockedBadge.hidden = !this.layer.locked;
    // Ask the server for the room state and announce the board to everyone.
    this.actions.send({ type: 'whiteboard.open' });
    this.render();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.draft = null;
    this.pointerId = null;
    this.element.hidden = true;
    this.actions.onVisibilityChange?.(false);
  }

  /** Re-evaluates the host/moderator-only controls (role changes, reconnects). */
  refreshRole(): void {
    this.toolbar.sync({ canClear: this.actions.canManage() });
    this.endButton.hidden = !this.actions.canManage();
    if (this.visible && this.layer.locked) this.lockedBadge.hidden = !this.actions.canManage();
  }

  /* ------------------------------ server sync ------------------------------ */

  applySnapshot(snapshot: WhiteboardSnapshot, reason: WhiteboardSyncReason): void {
    const dropPending = reason === 'clear' || reason === 'close';
    this.layer.applySnapshot(snapshot, { dropPending });
    if (snapshot.locked && this.visible && !this.actions.canManage()) {
      this.lockedBadge.hidden = false;
      this.setStatus(this.i18n.t('whiteboardLocked'), true);
    } else if (snapshot.open) {
      this.lockedBadge.hidden = true;
      if (this.status.dataset.kind === 'error') this.setStatus('', false);
    } else {
      this.lockedBadge.hidden = !snapshot.locked;
    }
    this.render();
  }

  applyStroke(stroke: WhiteboardStroke): void {
    if (!this.layer.ingest(stroke)) return;
    if (this.visible) this.render();
  }

  applyOpened(by: WhiteboardAuthor): void {
    this.layer.open = true;
    this.layer.locked = false;
    this.lockedBadge.hidden = true;
    if (this.status.dataset.kind === 'error') this.setStatus('', false);
    void by;
  }

  applyClosed(by: WhiteboardAuthor, reason: string): void {
    this.layer.open = false;
    this.layer.locked = true;
    this.lockedBadge.hidden = !this.visible || this.actions.canManage();
    if (this.visible) this.setStatus(this.i18n.t('whiteboardLocked'), true);
    void by;
    void reason;
  }

  /** Local reset on leave (the room state is kept on the server). */
  reset(): void {
    this.draft = null;
    this.pointerId = null;
    const wasVisible = this.visible;
    this.layer.reset();
    this.status.hidden = true;
    this.element.hidden = true;
    this.visible = false;
    if (wasVisible) this.actions.onVisibilityChange?.(false);
    if (this.renderer.width > 0) this.renderer.clear();
    this.render();
  }

  destroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.element.remove();
  }

  /* -------------------------------- canvas -------------------------------- */

  private bindCanvas(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (this.draft) return;
      event.preventDefault();
      const point = this.normalized(event, canvas);
      if (!point) return;
      if (this.layer.locked && !this.actions.canManage()) {
        this.setStatus(this.i18n.t('whiteboardLocked'), true);
        return;
      }
      if (!this.layer.open) this.actions.send({ type: 'whiteboard.open' });
      this.pointerId = event.pointerId;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
      const { tool, color, width } = this.toolbar.stateValue;
      this.draft = this.layer.begin(tool, color, width, this.actions.self());
      this.layer.addPoint(this.draft, point.x, point.y);
      this.canvasWrap.classList.add('is-drawing');
      this.render();
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.draft || this.pointerId !== event.pointerId) return;
      const point = this.normalized(event, canvas);
      if (!point) return;
      const previousCount = this.draft.points.length;
      if (!this.layer.addPoint(this.draft, point.x, point.y)) return;
      if (this.draft.points.length > previousCount) {
        this.renderer.drawSegment(this.draft, this.draft.points.length - 1);
      }
    });

    const finish = (event: PointerEvent): void => {
      if (!this.draft || this.pointerId !== event.pointerId) return;
      const draft = this.draft;
      this.draft = null;
      this.pointerId = null;
      this.canvasWrap.classList.remove('is-drawing');
      const message = this.layer.finish(draft);
      if (message) this.actions.send(message);
      this.render();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', (event) => {
      if (!this.draft || this.pointerId !== event.pointerId) return;
      const draft = this.draft;
      this.draft = null;
      this.pointerId = null;
      this.canvasWrap.classList.remove('is-drawing');
      if (draft.points.length === 0) this.layer.discard(draft);
      else {
        const message = this.layer.finish(draft);
        if (message) this.actions.send(message);
      }
      this.render();
    });
    canvas.addEventListener('lostpointercapture', () => {
      this.canvasWrap.classList.remove('is-drawing');
    });
  }

  private normalized(event: PointerEvent, canvas: HTMLCanvasElement): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  private handleResize(): void {
    if (!this.visible) return;
    const changed = this.renderer.resize();
    if (changed) this.renderer.drawAll(this.layer.items);
  }

  private render(): void {
    const empty = this.layer.items.length === 0;
    this.emptyHint.hidden = !empty;
    if (this.visible) {
      this.handleResize();
      this.renderer.drawAll(this.layer.items);
    }
    this.toolbar.sync({ canClear: this.actions.canManage() });
    this.endButton.hidden = !this.actions.canManage();
    this.actions.onChange?.();
  }

  private setStatus(text: string, error: boolean): void {
    this.status.hidden = text === '';
    this.status.textContent = text;
    this.status.dataset.kind = error ? 'error' : 'info';
  }
}

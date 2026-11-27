/**
 * Screen-share annotation layer (optional `features.annotations`).
 *
 * The layer is positioned exactly over the shared-screen tile (self share or a
 * remote presenter) and captures pointer events only while annotation mode is
 * on, so normal tile interactions keep working otherwise. Geometry is
 * normalized to the tile box; annotations belong to one screen share and the
 * server wipes them when the presenter stops or changes (documented limitation:
 * the overlay follows the tile bounds, not the letterboxed video content).
 */
import type { AnnotationSnapshot, AnnotationStroke, ClientMessage } from '@agil/protocol';
import { createStrokeLayer, type LocalStroke, type StrokeLayer } from '../call/whiteboard.js';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import { StrokeCanvas } from './whiteboard-canvas.js';
import { StrokeToolbar } from './stroke-toolbar.js';

export interface AnnotationOverlayActions {
  send: (message: ClientMessage) => void;
  canManage: () => boolean;
  isPresenter: () => boolean;
  self: () => { id: string; name: string };
  /** User turned annotation mode off (Escape / close button). */
  onExit: () => void;
  onNotice?: (text: string) => void;
}

export interface AnnotationTarget {
  presenterId: string;
  selfSharing: boolean;
}

export class AnnotationOverlay {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: AnnotationOverlayActions;
  private readonly layer: StrokeLayer = createStrokeLayer('annotation');
  private readonly toolbar: StrokeToolbar;
  private readonly renderer: StrokeCanvas;
  private readonly canvas: HTMLCanvasElement;
  private readonly hint: HTMLDivElement;
  private readonly targetName: HTMLSpanElement;
  private root: HTMLElement;
  private target: AnnotationTarget | null = null;
  private enabled = false;
  private draft: LocalStroke | null = null;
  private pointerId: number | null = null;
  private frame: number | null = null;
  private readonly onResize = (): void => this.scheduleSync();
  private readonly onVisibility = (): void => this.sync();

  constructor(root: HTMLElement, i18n: I18n, actions: AnnotationOverlayActions) {
    this.root = root;
    this.i18n = i18n;
    this.actions = actions;

    this.canvas = h('canvas', {
      class: 'agil-annotation-canvas',
      dataset: { agilAnnotationCanvas: '' },
      attrs: { 'aria-label': i18n.t('annotationsTitle') },
    });
    this.renderer = new StrokeCanvas(this.canvas);

    this.toolbar = new StrokeToolbar(i18n, {
      variant: 'annotation',
      canClear: () => this.actions.canManage() || this.actions.isPresenter(),
      onTool: (tool) => {
        this.canvas.dataset.tool = tool;
      },
      onColor: () => undefined,
      onWidth: () => undefined,
      onClear: () => {
        if (!this.actions.canManage() && !this.actions.isPresenter()) {
          actions.onNotice?.(i18n.t('annotationsPresenterOnly'));
          return;
        }
        actions.send(this.layer.command('clear'));
      },
    });
    this.canvas.dataset.tool = 'pen';
    this.toolbar.sync({ canClear: false });

    const exit = h('button', {
      class: 'agil-stroke-btn agil-annotation-exit',
      title: i18n.t('close'),
      dataset: { agilAnnotationAction: 'exit' },
      attrs: { 'aria-label': i18n.t('close') },
    });
    exit.type = 'button';
    exit.appendChild(icon('close', 18));
    exit.addEventListener('click', () => this.actions.onExit());

    this.targetName = h('span', { class: 'agil-annotation-target' });
    this.hint = h(
      'div',
      { class: 'agil-annotation-hint' },
      this.targetName,
      h('span', { class: 'agil-annotation-hint-text', text: i18n.t('annotationsHint') }),
    );

    this.element = h(
      'div',
      { class: 'agil-annotation-layer', dataset: { agilAnnotations: '' } },
      this.canvas,
      h('div', { class: 'agil-annotation-toolbar' }, this.toolbar.element, exit),
      this.hint,
    );
    this.element.hidden = true;
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.actions.onExit();
      }
    });
    root.appendChild(this.element);
    this.bindCanvas();
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.scheduleSync();
  }

  /* ------------------------------- lifecycle ------------------------------- */

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.dataset.enabled = String(enabled);
    this.element.classList.toggle('is-enabled', enabled);
    if (!enabled) {
      this.draft = null;
      this.pointerId = null;
    }
    // Synchronous first pass: requestAnimationFrame is paused in a background
    // tab, and annotations must stay in sync while the user switched tabs.
    this.sync();
    this.scheduleSync();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setTarget(target: AnnotationTarget | null, presenterName = ''): void {
    const changed = target?.presenterId !== this.target?.presenterId || Boolean(target) !== Boolean(this.target);
    this.target = target;
    if (changed) {
      // Annotations belong to one screen share: a new presenter starts clean.
      this.layer.reset();
      this.layer.presenterId = target?.presenterId ?? null;
      this.layer.open = Boolean(target);
      if (this.renderer.width > 0) this.renderer.clear();
    }
    this.targetName.textContent = presenterName ? presenterName : '';
    this.targetName.hidden = !presenterName;
    this.toolbar.sync({ canClear: this.actions.canManage() || this.actions.isPresenter() });
    this.sync();
    this.scheduleSync();
  }

  get strokeCount(): number {
    return this.layer.length;
  }

  handleSnapshot(snapshot: AnnotationSnapshot): void {
    this.layer.applySnapshot(snapshot);
    this.sync();
    this.scheduleSync();
  }

  handleStroke(stroke: AnnotationStroke): void {
    if (!this.layer.ingest(stroke)) return;
    this.sync();
    this.scheduleSync();
  }

  handleClear(reason: string): void {
    this.layer.reset();
    if (reason === 'share_ended' || reason === 'presenter_changed') {
      this.setTarget(null);
    }
    this.sync();
    this.scheduleSync();
  }

  reset(): void {
    this.layer.reset();
    this.draft = null;
    this.pointerId = null;
    this.target = null;
    this.enabled = false;
    this.element.hidden = true;
  }

  destroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.element.remove();
  }

  /* ------------------------------ positioning ------------------------------ */

  /** Schedules a position/render pass on the next animation frame. */
  scheduleSync(): void {
    if (typeof requestAnimationFrame !== 'function') {
      this.sync();
      return;
    }
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sync();
    });
  }

  /** Recomputes the overlay rectangle over the shared-screen tile. */
  sync(): void {
    if (!this.enabled || !this.target) {
      this.element.hidden = true;
      return;
    }
    const tile = this.findTile();
    if (!tile) {
      this.element.hidden = true;
      return;
    }
    const tileRect = tile.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    if (tileRect.width < 40 || tileRect.height < 40) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    this.element.style.left = `${Math.round(tileRect.left - rootRect.left)}px`;
    this.element.style.top = `${Math.round(tileRect.top - rootRect.top)}px`;
    this.element.style.width = `${Math.round(tileRect.width)}px`;
    this.element.style.height = `${Math.round(tileRect.height)}px`;
    const changed = this.renderer.resize();
    if (changed || this.layer.hasContent() || this.draft) this.renderer.drawAll(this.layer.items);
    else this.renderer.clear();
  }

  private findTile(): HTMLElement | null {
    const target = this.target;
    if (!target) return null;
    const tiles = Array.from(this.root.querySelectorAll<HTMLElement>('[data-agil-tile]'));
    if (target.selfSharing) {
      return tiles.find((tile) => tile.dataset.self === 'true') ?? null;
    }
    return tiles.find((tile) => tile.dataset.participantId === target.presenterId) ?? null;
  }

  /* -------------------------------- drawing -------------------------------- */

  private bindCanvas(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.enabled || !this.target) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (this.draft) return;
      const point = this.normalized(event);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      this.pointerId = event.pointerId;
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        /* best effort */
      }
      const { tool, color, width } = this.toolbar.stateValue;
      this.draft = this.layer.begin(tool, color, width, this.actions.self());
      this.layer.addPoint(this.draft, point.x, point.y);
      this.renderer.drawAll(this.layer.items);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.draft || this.pointerId !== event.pointerId) return;
      const point = this.normalized(event);
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
      const message = this.layer.finish(draft);
      if (message) this.actions.send(message);
      this.renderer.drawAll(this.layer.items);
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', (event) => {
      if (!this.draft || this.pointerId !== event.pointerId) return;
      const draft = this.draft;
      this.draft = null;
      this.pointerId = null;
      if (draft.points.length === 0) this.layer.discard(draft);
      else {
        const message = this.layer.finish(draft);
        if (message) this.actions.send(message);
      }
      this.renderer.drawAll(this.layer.items);
    });
  }

  private normalized(event: PointerEvent): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }
}

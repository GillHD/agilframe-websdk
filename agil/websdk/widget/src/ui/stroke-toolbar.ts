/**
 * Shared stroke toolbar for the whiteboard panel and the annotation overlay.
 *
 * Tools: pen, eraser, six colors, three widths, undo (board only) and clear
 * (host/moderator only — the server enforces the same rule). Buttons expose
 * stable hooks for e2e/screenshots: `data-agil-wb-tool`, `data-agil-wb-color`,
 * `data-agil-wb-width`, `data-agil-wb-action`.
 */
import { WHITEBOARD_COLORS, WHITEBOARD_WIDTHS } from '@agil/protocol';
import { h } from '../dom.js';
import type { I18n, I18nKey } from '../i18n.js';
import { icon } from '../icons.js';
import type { DrawTool } from '../call/whiteboard.js';

const COLOR_LABELS: Record<string, I18nKey> = {
  '#ef4444': 'colorRed',
  '#f59e0b': 'colorOrange',
  '#22c55e': 'colorGreen',
  '#3b82f6': 'colorBlue',
  '#a855f7': 'colorPurple',
  '#0f172a': 'colorInk',
};
const WIDTH_LABELS: Record<number, I18nKey> = {
  [WHITEBOARD_WIDTHS[0]]: 'widthThin',
  [WHITEBOARD_WIDTHS[1]]: 'widthMedium',
  [WHITEBOARD_WIDTHS[2]]: 'widthThick',
};

export interface StrokeToolbarOptions {
  variant: 'board' | 'annotation';
  canClear: () => boolean;
  onTool: (tool: DrawTool) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo?: () => void;
  onClear: () => void;
}

export interface StrokeToolbarState {
  tool: DrawTool;
  color: string;
  width: number;
  canClear: boolean;
  disabled?: boolean;
}

export class StrokeToolbar {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly toolButtons = new Map<DrawTool, HTMLButtonElement>();
  private readonly colorButtons = new Map<string, HTMLButtonElement>();
  private readonly widthButtons = new Map<number, HTMLButtonElement>();
  private clearButton: HTMLButtonElement | null = null;
  private undoButton: HTMLButtonElement | null = null;
  private state: StrokeToolbarState = { tool: 'pen', color: WHITEBOARD_COLORS[0], width: WHITEBOARD_WIDTHS[1], canClear: false };

  constructor(i18n: I18n, options: StrokeToolbarOptions) {
    this.i18n = i18n;
    this.element = h('div', {
      class: `agil-stroke-toolbar agil-stroke-toolbar-${options.variant}`,
      role: 'toolbar',
      attrs: { 'aria-label': i18n.t('whiteboardTitle') },
    });
    const tool = (id: DrawTool, label: I18nKey, iconName: 'pen' | 'eraser'): HTMLButtonElement => {
      const button = h('button', {
        class: 'agil-stroke-btn agil-stroke-tool',
        title: i18n.t(label),
        dataset: { agilWbTool: id },
        attrs: { 'aria-label': i18n.t(label), 'aria-pressed': 'false' },
      });
      button.type = 'button';
      button.appendChild(icon(iconName, 18));
      button.addEventListener('click', () => {
        this.state.tool = id;
        this.sync();
        options.onTool(id);
      });
      this.toolButtons.set(id, button);
      this.buttons.push(button);
      return button;
    };
    this.element.appendChild(tool('pen', 'whiteboardPen', 'pen'));
    this.element.appendChild(tool('eraser', 'whiteboardEraser', 'eraser'));

    const swatches = h('div', { class: 'agil-stroke-colors', attrs: { role: 'group', 'aria-label': i18n.t('whiteboardTitle') } });
    for (const color of WHITEBOARD_COLORS) {
      const label = i18n.t(COLOR_LABELS[color] ?? 'colorRed');
      const button = h('button', {
        class: 'agil-stroke-swatch',
        title: label,
        dataset: { agilWbColor: color },
        attrs: { 'aria-label': label, 'aria-pressed': 'false' },
        style: { '--agil-swatch': color },
      });
      button.type = 'button';
      button.addEventListener('click', () => {
        this.state.color = color;
        if (this.state.tool === 'eraser') this.state.tool = 'pen';
        this.sync();
        options.onColor(color);
      });
      this.colorButtons.set(color, button);
      this.buttons.push(button);
      swatches.appendChild(button);
    }
    this.element.appendChild(swatches);

    const widths = h('div', { class: 'agil-stroke-widths', attrs: { role: 'group', 'aria-label': i18n.t('whiteboardPen') } });
    for (const width of WHITEBOARD_WIDTHS) {
      const label = i18n.t(WIDTH_LABELS[width] ?? 'widthMedium');
      const button = h('button', {
        class: 'agil-stroke-width',
        title: label,
        dataset: { agilWbWidth: String(width) },
        attrs: { 'aria-label': label, 'aria-pressed': 'false' },
      });
      button.type = 'button';
      const dot = h('span', { class: 'agil-stroke-width-dot' });
      dot.style.width = `${Math.round(3 + (width / WHITEBOARD_WIDTHS[2]) * 9)}px`;
      dot.style.height = dot.style.width;
      button.appendChild(dot);
      button.addEventListener('click', () => {
        this.state.width = width;
        this.sync();
        options.onWidth(width);
      });
      this.widthButtons.set(width, button);
      this.buttons.push(button);
      widths.appendChild(button);
    }
    this.element.appendChild(widths);

    const spacer = h('span', { class: 'agil-stroke-spacer' });
    this.element.appendChild(spacer);

    if (options.variant === 'board' && options.onUndo) {
      const undo = h('button', {
        class: 'agil-stroke-btn',
        title: i18n.t('whiteboardUndo'),
        dataset: { agilWbAction: 'undo' },
        attrs: { 'aria-label': i18n.t('whiteboardUndo') },
      });
      undo.type = 'button';
      undo.appendChild(icon('undo', 18));
      undo.addEventListener('click', () => options.onUndo?.());
      this.undoButton = undo;
      this.buttons.push(undo);
      this.element.appendChild(undo);
    }

    const clearLabel = options.variant === 'annotation' ? 'annotationsClear' : 'whiteboardClear';
    const clear = h('button', {
      class: 'agil-stroke-btn agil-stroke-clear',
      title: i18n.t(clearLabel),
      dataset: { agilWbAction: 'clear' },
      attrs: { 'aria-label': i18n.t(clearLabel) },
    });
    clear.type = 'button';
    clear.appendChild(icon('trash', 18));
    clear.addEventListener('click', () => options.onClear());
    this.clearButton = clear;
    this.buttons.push(clear);
    this.element.appendChild(clear);
    this.sync();
  }

  /** Applies pressed/disabled state without rebuilding the toolbar. */
  sync(state: Partial<StrokeToolbarState> = {}): void {
    this.state = { ...this.state, ...state };
    for (const [id, button] of this.toolButtons) {
      const active = this.state.tool === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const [color, button] of this.colorButtons) {
      const active = this.state.tool === 'pen' && this.state.color === color;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const [width, button] of this.widthButtons) {
      const active = this.state.width === width;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (this.undoButton) this.undoButton.disabled = Boolean(this.state.disabled);
    if (this.clearButton) {
      this.clearButton.hidden = !this.state.canClear;
      this.clearButton.disabled = Boolean(this.state.disabled);
    }
    this.element.dataset.tool = this.state.tool;
    for (const button of this.buttons) {
      if (button === this.clearButton) continue;
      button.disabled = Boolean(this.state.disabled);
    }
  }

  get stateValue(): StrokeToolbarState {
    return this.state;
  }
}

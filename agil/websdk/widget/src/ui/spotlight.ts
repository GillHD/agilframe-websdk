/**
 * Spotlight coach overlay: dims the call UI, highlights one control and shows a
 * hint with optional multi-step navigation (contract: docs/in-call-agent.md §3).
 *
 * Design constraints:
 *  - does not block the call: only the hint card is interactive;
 *  - dimming is done with four rectangles around the target, so the highlighted
 *    control stays clickable and visible (no stacking-context hacks);
 *  - Esc closes, aria-live announces the hint, focus moves to the card;
 *  - the root gets `data-agil-spotlight="true"` and the target gets
 *    `[data-agil-spotlight-target]`.
 */
import type { AssistantSpotlight } from '@agil/protocol';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';

const LOGICAL_TARGETS: Record<string, string> = {
  hand: '[data-agil-action="hand"]',
  raise_hand: '[data-agil-action="hand"]',
  mic: '[data-agil-action="mic"]',
  camera: '[data-agil-action="camera"]',
  screen: '[data-agil-action="screen"]',
  chat: '[data-agil-action="chat"]',
  files: '[data-agil-action="chat"]',
  participants: '[data-agil-action="participants"]',
  notes: '[data-agil-action="notes"]',
  transcript: '[data-agil-action="transcript"]',
  settings: '[data-agil-action="settings"]',
  blur: '[data-agil-action="blur"]',
  recording: '[data-agil-action="recording"]',
  minimize: '[data-agil-action="minimize"]',
  restore: '[data-agil-action="restore"]',
  fullscreen: '[data-agil-action="fullscreen"]',
  newtab: '[data-agil-action="newtab"]',
  invite: '[data-agil-action="invite"]',
};

export class AssistantSpotlightOverlay {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly container: HTMLDivElement;
  private readonly dimTop: HTMLDivElement;
  private readonly dimBottom: HTMLDivElement;
  private readonly dimLeft: HTMLDivElement;
  private readonly dimRight: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly cardText: HTMLParagraphElement;
  private readonly cardCounter: HTMLSpanElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly doneButton: HTMLButtonElement;
  private steps: AssistantSpotlight[] = [];
  private index = 0;
  private target: Element | null = null;
  private active = false;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.hide();
    } else if (event.key === 'ArrowRight') {
      this.goTo(this.index + 1);
    } else if (event.key === 'ArrowLeft') {
      this.goTo(this.index - 1);
    }
  };
  private readonly onResize = (): void => this.position();

  constructor(root: HTMLElement, i18n: I18n) {
    this.root = root;
    this.i18n = i18n;
    this.dimTop = h('div', { class: 'agil-spotlight-dim' });
    this.dimBottom = h('div', { class: 'agil-spotlight-dim' });
    this.dimLeft = h('div', { class: 'agil-spotlight-dim' });
    this.dimRight = h('div', { class: 'agil-spotlight-dim' });
    this.ring = h('div', { class: 'agil-spotlight-ring' });
    this.cardText = h('p', { class: 'agil-spotlight-text' });
    this.cardCounter = h('span', { class: 'agil-spotlight-counter' });
    this.prevButton = h('button', { class: 'agil-btn agil-btn-ghost', text: i18n.t('assistantPrev') });
    this.prevButton.type = 'button';
    this.prevButton.addEventListener('click', () => this.goTo(this.index - 1));
    this.nextButton = h('button', { class: 'agil-btn agil-btn-secondary', text: i18n.t('assistantNext') });
    this.nextButton.type = 'button';
    this.nextButton.addEventListener('click', () => this.goTo(this.index + 1));
    this.doneButton = h('button', { class: 'agil-btn agil-btn-primary', text: i18n.t('assistantDone') });
    this.doneButton.type = 'button';
    this.doneButton.addEventListener('click', () => this.hide());
    const head = h(
      'div',
      { class: 'agil-spotlight-head' },
      h('span', { class: 'agil-spotlight-icon' }, icon('info', 16)),
      h('span', { class: 'agil-spotlight-label', text: i18n.t('assistantSpotlightHint') }),
      this.cardCounter,
    );
    const controls = h('div', { class: 'agil-spotlight-controls' }, this.prevButton, this.nextButton, this.doneButton);
    this.card = h('div', {
      class: 'agil-spotlight-card',
      attrs: {
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': i18n.t('assistantSpotlightHint'),
        'aria-live': 'polite',
        tabindex: '-1',
      },
    });
    this.card.appendChild(head);
    this.card.appendChild(this.cardText);
    this.card.appendChild(controls);
    this.container = h(
      'div',
      { class: 'agil-spotlight', attrs: { 'aria-live': 'polite' } },
      this.dimTop,
      this.dimBottom,
      this.dimLeft,
      this.dimRight,
      this.ring,
      this.card,
    );
    this.container.hidden = true;
    this.container.style.pointerEvents = 'none';
    this.card.style.pointerEvents = 'auto';
    this.root.appendChild(this.container);
  }

  get isActive(): boolean {
    return this.active;
  }

  show(steps: AssistantSpotlight[]): void {
    const sorted = [...steps]
      .filter((step) => step && typeof step.target === 'string' && typeof step.text === 'string')
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
    if (sorted.length === 0) return;
    this.steps = sorted;
    this.index = 0;
    this.active = true;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.container.hidden = false;
    this.root.dataset.agilSpotlight = 'true';
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    this.renderStep();
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = setTimeout(() => this.hide(), 12_000);
    this.container.addEventListener('click', (event) => {
      if (event.target === this.container) this.hide();
    });
    // The hint card is a dialog: move focus into it (no scroll jump) so screen
    // readers announce the step and Tab reaches the Далее/Назад/Понятно buttons.
    try {
      this.card.focus({ preventScroll: true });
    } catch {
      this.card.focus();
    }
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    if (this.autoCloseTimer) { clearTimeout(this.autoCloseTimer); this.autoCloseTimer = null; }
    this.container.hidden = true;
    this.root.dataset.agilSpotlight = 'false';
    if (this.target) {
      this.target.removeAttribute('data-agil-spotlight-target');
      this.target.classList.remove('agil-spotlight-targeted');
      if (this.target.getAttribute('data-agil-spotlight-tabindex') !== null) {
        const previous = this.target.getAttribute('data-agil-spotlight-tabindex');
        if (previous) this.target.setAttribute('tabindex', previous);
        else this.target.removeAttribute('tabindex');
        this.target.removeAttribute('data-agil-spotlight-tabindex');
      }
      this.target = null;
    }
    document.removeEventListener('keydown', this.onKeyDown, true);
    const restore = this.previousFocus;
    this.previousFocus = null;
    if (restore && document.contains(restore)) {
      try {
        restore.focus({ preventScroll: true });
      } catch {
        restore.focus();
      }
    }
    window.removeEventListener('resize', this.onResize);
  }

  private goTo(index: number): void {
    if (index < 0) return;
    if (index >= this.steps.length) {
      this.hide();
      return;
    }
    this.index = index;
    this.renderStep();
  }

  private findTarget(targetName: string): Element | null {
    const logical = LOGICAL_TARGETS[targetName];
    const selector = logical ?? targetName;
    try {
      const element = this.root.querySelector(selector);
      if (element) return element;
    } catch {
      /* invalid CSS selector from an LLM — ignore */
    }
    if (logical) {
      try {
        return document.querySelector(logical);
      } catch {
        return null;
      }
    }
    return null;
  }

  private renderStep(): void {
    const step = this.steps[this.index];
    if (!step) {
      this.hide();
      return;
    }
    this.cardText.textContent = step.text;
    this.cardCounter.textContent = `${this.i18n.t('assistantStep')} ${this.index + 1}/${this.steps.length}`;
    this.prevButton.disabled = this.index === 0;
    this.prevButton.style.visibility = this.index === 0 ? 'hidden' : '';
    this.nextButton.style.display = this.index >= this.steps.length - 1 ? 'none' : '';
    if (this.target) {
      this.target.removeAttribute('data-agil-spotlight-target');
      this.target.classList.remove('agil-spotlight-targeted');
    }
    const nextTarget = this.findTarget(step.target);
    this.target = nextTarget;
    if (nextTarget) {
      nextTarget.setAttribute('data-agil-spotlight-target', step.target);
      if (!nextTarget.hasAttribute('tabindex')) {
        nextTarget.setAttribute('data-agil-spotlight-tabindex', '');
        nextTarget.setAttribute('tabindex', '-1');
      }
      nextTarget.classList.add('agil-spotlight-targeted');
      try {
        nextTarget.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {
        /* ignore */
      }
      try {
        nextTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch {
        /* ignore */
      }
    }
    this.position();
  }

  private position(): void {
    if (!this.active) return;
    const rootRect = this.root.getBoundingClientRect();
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    const targetRect = this.target?.getBoundingClientRect() ?? null;
    // Root-relative rect of the highlight hole.
    const pad = 6;
    const hole = targetRect
      ? {
          left: Math.max(0, targetRect.left - rootRect.left - pad),
          top: Math.max(0, targetRect.top - rootRect.top - pad),
          width: Math.min(width, targetRect.width + pad * 2),
          height: Math.min(height, targetRect.height + pad * 2),
        }
      : { left: width / 2 - 40, top: height / 2 - 40, width: 80, height: 80 };

    this.ring.style.left = `${hole.left}px`;
    this.ring.style.top = `${hole.top}px`;
    this.ring.style.width = `${hole.width}px`;
    this.ring.style.height = `${hole.height}px`;
    const rightEdge = hole.left + hole.width;
    const bottomEdge = hole.top + hole.height;
    this.dimTop.style.cssText = `left:0;top:0;width:100%;height:${Math.max(0, hole.top)}px;`;
    this.dimBottom.style.cssText = `left:0;top:${bottomEdge}px;width:100%;height:${Math.max(0, height - bottomEdge)}px;`;
    this.dimLeft.style.cssText = `left:0;top:${hole.top}px;width:${Math.max(0, hole.left)}px;height:${hole.height}px;`;
    this.dimRight.style.cssText = `left:${rightEdge}px;top:${hole.top}px;width:${Math.max(0, width - rightEdge)}px;height:${hole.height}px;`;

    // Place the hint card near the target, clamped to the widget bounds.
    const cardWidth = Math.min(360, Math.max(240, width - 24));
    this.card.style.width = `${cardWidth}px`;
    const spaceBelow = height - bottomEdge;
    const placeAbove = spaceBelow < 150 && hole.top > 170;
    const cardTop = placeAbove ? Math.max(8, hole.top - 160) : Math.min(height - 150, bottomEdge + 12);
    const cardLeft = Math.max(8, Math.min(width - cardWidth - 8, hole.left + hole.width / 2 - cardWidth / 2));
    this.card.style.left = `${cardLeft}px`;
    this.card.style.top = `${Math.max(8, cardTop)}px`;
  }

  destroy(): void {
    this.hide();
    this.container.remove();
  }
}

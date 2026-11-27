/**
 * Participant banner shown while inside a breakout room:
 * «Вы в подкомнате N · До конца mm:ss · Вернуться».
 *
 * The banner sits in the footer above the control bar (safe-area aware on
 * phones) and is a polite live region. The live timer is `aria-hidden` so
 * screen readers are not spammed every second.
 */
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';

export interface BreakoutBannerView {
  /** 1-based sub-room index. */
  index: number;
  /** Human room name (tooltip only, never required for the message). */
  name: string;
  remainingSec: number;
  hasDeadline: boolean;
  allowReturn: boolean;
  switching: boolean;
}

export interface BreakoutBannerActions {
  onReturn: () => void;
}

export class BreakoutBanner {
  readonly element: HTMLDivElement;
  private readonly i18n: I18n;
  private readonly textEl: HTMLSpanElement;
  private readonly timerEl: HTMLSpanElement;
  private readonly returnButton: HTMLButtonElement;

  constructor(i18n: I18n, actions: BreakoutBannerActions) {
    this.i18n = i18n;
    this.textEl = h('span', { class: 'agil-banner-text agil-breakout-banner-text' });
    this.timerEl = h('span', { class: 'agil-breakout-banner-timer', attrs: { 'aria-hidden': 'true' } });
    this.returnButton = h('button', {
      class: 'agil-btn agil-btn-primary agil-breakout-banner-return',
      dataset: { agilBreakoutReturn: '' },
    });
    this.returnButton.type = 'button';
    this.returnButton.addEventListener('click', () => actions.onReturn());
    this.element = h(
      'div',
      {
        class: 'agil-banner agil-breakout-banner',
        dataset: { agilBreakoutBanner: '' },
        attrs: { role: 'status', 'aria-live': 'polite' },
      },
      h('span', { class: 'agil-banner-icon' }, icon('grid', 16)),
      this.textEl,
      this.timerEl,
      this.returnButton,
    );
    this.element.hidden = true;
  }

  show(view: BreakoutBannerView): void {
    const switching = view.switching;
    const text = switching
      ? this.i18n.t('breakoutSwitching')
      : this.i18n.t('breakoutBannerTitle', { n: view.index });
    if (this.textEl.textContent !== text) this.textEl.textContent = text;
    this.textEl.title = view.name;
    this.element.dataset.kind = 'info';

    if (!switching && view.hasDeadline) {
      this.timerEl.hidden = false;
      this.timerEl.textContent = `· ${this.i18n.t('breakoutEndsIn', { time: formatDuration(view.remainingSec) })}`;
    } else {
      this.timerEl.hidden = true;
      this.timerEl.textContent = '';
    }

    if (view.allowReturn && !switching) {
      this.returnButton.hidden = false;
      this.returnButton.textContent = this.i18n.t('breakoutReturn');
      this.returnButton.disabled = false;
      this.returnButton.setAttribute('aria-label', this.i18n.t('breakoutReturn'));
    } else {
      this.returnButton.hidden = true;
    }
    this.element.hidden = false;
  }

  hide(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

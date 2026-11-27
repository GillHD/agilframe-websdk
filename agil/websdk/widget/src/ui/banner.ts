/** Degradation banner: "weak connection — chat keeps working". */
import { h } from '../dom.js';
import { icon } from '../icons.js';

export type BannerKind = 'warning' | 'critical' | 'info';

export class Banner {
  readonly element: HTMLDivElement;
  private readonly textEl: HTMLSpanElement;
  private readonly iconWrap: HTMLSpanElement;

  constructor() {
    this.textEl = h('span', { class: 'agil-banner-text' });
    this.iconWrap = h('span', { class: 'agil-banner-icon' });
    this.element = h('div', { class: 'agil-banner', attrs: { role: 'status', 'aria-live': 'polite' } }, this.iconWrap, this.textEl);
    this.element.hidden = true;
  }

  show(message: string, kind: BannerKind = 'warning'): void {
    this.textEl.textContent = message;
    this.iconWrap.replaceChildren(icon(kind === 'info' ? 'info' : 'warning', 16));
    this.element.dataset.kind = kind;
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

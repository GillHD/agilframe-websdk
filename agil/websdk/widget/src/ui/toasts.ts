/** Lightweight toast notifications (no dependencies). */
import { h } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

const ICONS: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'warning',
};

export class ToastManager {
  readonly element: HTMLDivElement;
  private readonly items = new Map<string, { el: HTMLElement; count: number; label: HTMLSpanElement; timer: ReturnType<typeof setTimeout> | null }>();
  private static readonly MAX_VISIBLE = 2;

  constructor() {
    this.element = h('div', { class: 'agil-toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
  }

  show(message: string, kind: ToastKind = 'info', timeoutMs = 4200, actions?: ToastAction[]): HTMLElement {
    const key = `${kind}:${message}`;
    const existing = this.items.get(key);
    if (existing) {
      // Coalesce duplicate notifications into one toast with an "×N" counter.
      existing.count += 1;
      existing.label.textContent = `×${existing.count}`;
      existing.label.hidden = false;
      this.armTimer(key, existing, timeoutMs);
      existing.el.classList.remove('is-leaving');
      return existing.el;
    }
    // Limit the stack so a notification storm cannot cover the call UI.
    while (this.items.size >= ToastManager.MAX_VISIBLE) {
      const first = this.items.keys().next().value;
      if (first === undefined) break;
      this.remove(first, true);
    }
    const toast = h('div', { class: `agil-toast agil-toast-${kind}` });
    toast.appendChild(icon(ICONS[kind], 16));
    const label = h('span', { class: 'agil-toast-count', text: '×1' });
    label.hidden = true;
    toast.appendChild(h('span', { class: 'agil-toast-text', text: message }));
    toast.appendChild(label);
    if (actions && actions.length > 0) {
      const row = h('div', { class: 'agil-toast-actions' });
      for (const action of actions) {
        const button = h('button', { class: 'agil-toast-action', text: action.label });
        button.type = 'button';
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          action.onClick();
        });
        row.appendChild(button);
      }
      toast.appendChild(row);
    }
    toast.addEventListener('click', () => this.dismiss(key));
    this.element.appendChild(toast);
    const entry = { el: toast, count: 1, label, timer: null as ReturnType<typeof setTimeout> | null };
    this.items.set(key, entry);
    this.armTimer(key, entry, timeoutMs);
    return toast;
  }

  private armTimer(key: string, entry: { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }, timeoutMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (timeoutMs <= 0) return;
    entry.timer = setTimeout(() => this.dismiss(key), timeoutMs);
  }

  dismissMessage(message: string, kind: ToastKind = 'info'): void {
    this.remove(`${kind}:${message}`, true);
  }

  private dismiss(key: string): void {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.add('is-leaving');
    setTimeout(() => entry.el.remove(), 250);
  }

  private remove(key: string, immediate: boolean): void {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (immediate) entry.el.remove();
    else this.dismiss(key);
  }

  clear(): void {
    for (const entry of this.items.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.el.remove();
    }
    this.items.clear();
    this.element.replaceChildren();
  }
}

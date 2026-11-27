/** Small shared helpers for the landing: toast, clipboard, element lookup. */

export const $ = <T extends Element>(selector: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(selector);

export const $$ = <T extends Element>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

export function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`landing: element ${selector} not found`);
  return element;
}

let toastTimer = 0;

/** One polite live region for every landing/demo action. */
export function showToast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const toast = $<HTMLElement>('#toast');
  const text = $<HTMLElement>('#toast .toast-text');
  if (!toast || !text) return;
  text.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

export function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
  if (busy) {
    button.dataset.idleLabel = button.dataset.idleLabel ?? button.textContent?.trim() ?? '';
    const label = button.querySelector<HTMLElement>('.btn-label');
    if (label) {
      button.dataset.idleLabel = label.textContent ?? button.dataset.idleLabel;
      label.textContent = busyLabel ?? 'Подождите…';
    } else {
      button.textContent = busyLabel ?? 'Подождите…';
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    return;
  }
  const label = button.querySelector<HTMLElement>('.btn-label');
  if (label && button.dataset.idleLabel) label.textContent = button.dataset.idleLabel;
  button.disabled = false;
  button.removeAttribute('aria-busy');
}

/** Clipboard with a legacy fallback for insecure contexts and denied permission. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.append(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

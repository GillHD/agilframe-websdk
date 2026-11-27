/**
 * Tiny DOM helpers (no framework by design — the widget ships as a single
 * self-contained script and must not drag a virtual DOM along).
 */

export type Child = Node | string | number | null | undefined | false;

export type EventHandlers = {
  [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
};

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  role?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  style?: Record<string, string>;
  on?: EventHandlers;
}

function applyProps(el: HTMLElement, props: Props | null | undefined): void {
  if (!props) return;
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title !== undefined) el.title = props.title;
  if (props.role !== undefined) el.setAttribute('role', props.role);
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) el.dataset[key] = value;
  }
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      if (key.startsWith('--')) el.style.setProperty(key, value);
      else (el.style as unknown as Record<string, string>)[key] = value;
    }
  }
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      if (typeof handler === 'function') el.addEventListener(type, handler as EventListener);
    }
  }
}

function appendChild(el: HTMLElement, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
}

/** Hyperscript: `h('div', { class: 'x' }, child1, 'text', ...)`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  for (const child of children) appendChild(el, child);
  return el;
}

/** SVG element factory (NS-aware). */
export function svg(tag: string, attrs: Record<string, string>, children: SVGElement[] = []): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  for (const child of children) el.appendChild(child);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

/** Safe text setter (never interprets markup). */
export function setText(el: Element | null, value: string): void {
  if (el) el.textContent = value;
}

export function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): () => void {
  el.addEventListener(type, handler as EventListener);
  return () => el.removeEventListener(type, handler as EventListener);
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function formatBytes(bytes: number, locale: 'ru' | 'en' = 'ru'): string {
  const units = locale === 'en' ? ['B', 'KB', 'MB', 'GB'] : ['Б', 'КБ', 'МБ', 'ГБ'];
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${units[0]}`;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index] ?? units[0]}`;
}

export function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export function uid(prefix = ''): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix ? `${prefix}-${random}` : random;
}

/** Tiny DOM builder shared by every panel component (no framework, no deps). */

export type Child = Node | string | number | null | undefined | false;
export type AttrValue = string | number | boolean | null | undefined;

export interface ElementOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, AttrValue>;
  dataset?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
}

/** Creates an element, applies attributes/classes and appends children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) node.addEventListener(type, handler);
  }
  append(node, ...children);
  return node;
}

/** Appends children, skipping nullish/false and stringifying primitives. */
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, ...children);
}

export function frag(...children: Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  append(fragment, ...children);
  return fragment;
}

/** Adds a listener and returns an unsubscribe function. */
export function listen(
  target: EventTarget,
  type: string,
  handler: (event: Event) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Toggles the loading state of a button without losing its label. */
export function setButtonLoading(target: HTMLButtonElement, loading: boolean): void {
  target.classList.toggle('is-loading', loading);
  target.disabled = loading;
  target.setAttribute('aria-busy', loading ? 'true' : 'false');
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs = 250): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delayMs);
  };
}

/** Id generator for aria-labelledby / aria-controls wiring. */
let uidCounter = 0;
export function uid(prefix = 'agil'): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

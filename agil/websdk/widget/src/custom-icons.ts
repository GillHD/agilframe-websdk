/**
 * `iconUrls` support: replace built-in SVG icons with host-provided images.
 *
 * Security: only http(s) URLs are accepted (relative URLs resolve against the
 * document) and the replacement is always an `<img>` element created with DOM
 * APIs — no `innerHTML`, no raw HTML/SVG strings, no `data:`/`javascript:`.
 * Unknown icon names and invalid URLs are ignored (the built-in SVG stays).
 *
 * A `MutationObserver` keeps replacements working across re-renders. If an image
 * fails to load, the original SVG is restored and the failed attempt is not
 * retried for that node (no render loop).
 */
import { isIconName, type IconName } from './icons.js';

const IMAGE_CLASS = 'agil-icon agil-icon-custom';

function defaultBaseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof window !== 'undefined' && window.location?.href) return window.location.href;
  return 'http://localhost/';
}

/** Resolves/validates one icon URL. Only http(s) URLs are allowed. */
export function resolveIconUrl(raw: string, baseUrl: string = defaultBaseUrl()): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim(), baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Validates an `iconUrls` map and drops unknown names/invalid URLs. */
export function resolveIconOverrides(
  iconUrls: Record<string, string> | undefined,
  baseUrl: string = defaultBaseUrl(),
): Map<IconName, string> {
  const result = new Map<IconName, string>();
  if (!iconUrls || typeof iconUrls !== 'object') return result;
  for (const [name, raw] of Object.entries(iconUrls)) {
    if (!isIconName(name) || typeof raw !== 'string') continue;
    const url = resolveIconUrl(raw, baseUrl);
    if (url) result.set(name, url);
  }
  return result;
}

/**
 * Builds the replacement `<img>` for an SVG icon. Exported for tests/hosts that
 * implement their own DOM integration; `applyIconOverrides` uses it.
 */
export function createIconImage(svg: Element, url: string): HTMLImageElement {
  const width = svg.getAttribute('width') || svg.getAttribute('data-agil-icon-size') || '20';
  const height = svg.getAttribute('height') || width;
  const img = document.createElement('img');
  img.className = IMAGE_CLASS;
  img.src = url;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.setAttribute('focusable', 'false');
  img.setAttribute('width', width);
  img.setAttribute('height', height);
  img.width = Number.parseInt(width, 10) || 20;
  img.height = Number.parseInt(height, 10) || 20;
  img.decoding = 'async';
  img.loading = 'eager';
  img.referrerPolicy = 'no-referrer';
  return img;
}

export interface IconOverridesHandle {
  destroy(): void;
}

/** Applies icon overrides to an existing widget subtree and keeps them applied. */
export function applyIconOverrides(
  root: HTMLElement,
  iconUrls: Record<string, string> | undefined,
): IconOverridesHandle {
  const overrides = resolveIconOverrides(iconUrls);
  if (overrides.size === 0) return { destroy: () => undefined };

  let observer: MutationObserver | null = null;
  let scheduled = false;
  let disposed = false;

  const replaceOne = (svg: Element): void => {
    const name = svg.getAttribute('data-agil-icon');
    if (!name || !isIconName(name)) return;
    if (svg.getAttribute('data-agil-icon-failed') === 'true') return;
    const url = overrides.get(name);
    if (!url) return;
    const parent = svg.parentNode;
    if (!parent) return;
    const img = createIconImage(svg, url);
    img.setAttribute('data-agil-icon-for', name);
    img.addEventListener(
      'error',
      () => {
        // Restore the built-in icon and mark it so the observer does not fight
        // with the failed replacement in a loop.
        svg.setAttribute('data-agil-icon-failed', 'true');
        if (img.parentNode) img.parentNode.replaceChild(svg, img);
      },
      { once: true },
    );
    parent.replaceChild(img, svg);
  };

  const apply = (): void => {
    if (disposed) return;
    const nodes = root.querySelectorAll('svg[data-agil-icon]');
    observer?.disconnect();
    try {
      nodes.forEach((node) => replaceOne(node));
    } finally {
      if (observer && !disposed) observe();
    }
  };

  const schedule = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    const run = (): void => {
      scheduled = false;
      apply();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else void Promise.resolve().then(run);
  };

  function observe(): void {
    if (!observer || disposed) return;
    observer.observe(root, { childList: true, subtree: true });
  }

  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => schedule());
    observe();
  }
  apply();

  return {
    destroy: () => {
      disposed = true;
      observer?.disconnect();
      observer = null;
    },
  };
}
